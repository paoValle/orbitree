/**
 * The e2e suite builds its repositories with the real `git` binary, exactly as the core's
 * fixtures do, and for the same reason: a fixture made by the product would agree with the
 * product's own bug. Nothing here imports `packages/core` — the test's job is to disagree
 * with the app when the app is wrong, so it must not share the app's code.
 */
import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { type ElectronApplication, _electron as electron, type Page } from '@playwright/test';
import type { PersistedState } from '../../src/shared/api.ts';

const run = promisify(execFile);

/**
 * One directory per run, holding every repository and every user-data directory this run creates.
 *
 * Per spec they leaked: a spec that forgot to remove its fixture left it in the system temp
 * directory for good, and a day of runs left 229 of them and 43 MB behind. One parent directory,
 * removed when the process ends however it ends, means forgetting is no longer possible.
 */
let runRootPromise: Promise<string> | null = null;

function runRoot(): Promise<string> {
  // Created by `globalSetup` so that `globalTeardown` can remove it whatever happens to a worker.
  const fromSetup = process.env.ORBITREE_RUN_DIR;
  if (fromSetup !== undefined && fromSetup !== '') return Promise.resolve(fromSetup);
  runRootPromise ??= mkdtemp(join(tmpdir(), 'orbitree-run-')).then((root) => {
    // A spec that kills the process, or a runner that stops the suite, still leaves nothing: the
    // synchronous removal in an exit handler runs on every path out.
    process.once('exit', () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Nothing useful to do while the process is going away.
      }
    });
    return root;
  });
  return runRootPromise;
}

/**
 * A directory of this run's own, for a spec that needs one that is not a repository or a
 * user-data directory. Inside the run root, so the exit handler removes it too.
 */
export async function makeRunDir(prefix: string): Promise<string> {
  return mkdtemp(join(await runRoot(), prefix));
}

export const APP_PATH = join(import.meta.dirname, '..', '..');

/** The CLI entry point, for the test that proves the app and the CLI build the same commit. */
const CLI = join(APP_PATH, '..', '..', 'bin', 'orbitree');

export interface AppHandle {
  readonly app: ElectronApplication;
  readonly userDataDir: string;
}

/**
 * Launches the built app, always with a fresh `--user-data-dir`. Without it Electron writes
 * caches, cookies and Local Storage into the real application support directory, so a test
 * run leaves residue on the machine it ran on, and one test can see another's state.
 */
export async function launchApp(
  repo?: string,
  options: {
    readonly userDataDir?: string;
    readonly tray?: boolean;
    readonly quiet?: boolean;
  } = {},
): Promise<AppHandle> {
  const userDataDir = options.userDataDir ?? (await mkdtemp(join(await runRoot(), 'userdata-')));
  const app = await electron.launch({
    args: [
      APP_PATH,
      // Quiet by default, and it matters: without it every spec pops a window that steals focus
      // from whoever is using the machine, and registers a global hotkey that swallows their
      // keystrokes. The window is created and rendered either way; only its visibility changes.
      // One spec is about a window being shown, and it is the one that passes `quiet: false`.
      ...(options.quiet === false ? [] : ['--quiet']),
      ...(options.tray === true ? ['--tray'] : []),
      ...(repo === undefined ? [] : [`--repo=${repo}`]),
      `--user-data-dir=${userDataDir}`,
    ],
    cwd: APP_PATH,
  });
  return { app, userDataDir };
}

export interface CloseOptions {
  /** Leave the user data directory in place, for a test that launches again into it. */
  readonly keep?: boolean;
}

/**
 * Closes the app the harness launched.
 *
 * `app.close()` asks it politely, and since the app closes to the tray rather than quitting
 * — which is the behaviour under test — the polite ask is not always enough. So there is a
 * grace period and then a signal. A test suite that leaves a process per spec behind is
 * worse than one that kills them.
 */
/**
 * The main window, chosen by what it is rather than by which loaded first.
 *
 * Both windows exist from startup now — the app creates its quick window as soon as it is
 * ready — so `firstWindow()` can hand back either, and the quick window has no graph.
 */
export async function mainWindow(app: ElectronApplication): Promise<Page> {
  // Both windows are created at startup, and both sit at `about:blank` until they have
  // navigated. The quick window is the one that navigates to `?popup=1`, so that is the
  // discriminator to wait for: until it exists, no page can be told from its neighbour.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pages = await app.windows();
    const popup = pages.find((page) => page.url().includes('popup=1'));
    if (popup !== undefined) {
      const main = pages.find((page) => page !== popup);
      if (main !== undefined) return main;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the main window never became distinguishable from the quick window');
}

export async function closeApp(handle: AppHandle, options: CloseOptions = {}): Promise<void> {
  const child = handle.app.process();
  handle.app.close().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  if (child.exitCode === null) child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  // Deleted by default so a run leaves nothing behind, but a test that proves persistence
  // across two launches has to keep the first one's directory.
  if (options.keep !== true) await rm(handle.userDataDir, { recursive: true, force: true });
}

/**
 * The state as the renderer sees it, unwrapped.
 *
 * `readState` answers with a result, not a value, and a spec that reads `.value` without asking
 * whether it is there is a spec that would compare against `undefined` and call it a difference.
 * A read that fails is a failed test.
 */
export async function readStateFrom(page: Page): Promise<PersistedState> {
  const result = await page.evaluate(() => window.orbitree.readState());
  if (!result.ok) throw new Error(`readState failed: ${result.error}`);
  return result.value;
}

/** The persisted state, as the file itself says it is rather than as a channel reports it. */
export async function readStateFile(userDataDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(userDataDir, 'state.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim();
}

export interface MakeRepoOptions {
  /** A first commit with this exact content, so HEAD is not unborn. */
  readonly base?: string;
  /** One file written and staged on top of the base, so there is something to commit. */
  readonly staged?: { readonly path: string; readonly content: string };
}

export async function makeRepo(options: MakeRepoOptions = {}): Promise<string> {
  const root = await mkdtemp(join(await runRoot(), 'repo-'));
  await git(root, ['init', '-b', 'main', '--quiet']);
  await git(root, ['config', 'user.name', 'E2E Author']);
  await git(root, ['config', 'user.email', 'e2e@example.invalid']);
  await git(root, ['config', 'commit.gpgsign', 'false']);
  await git(root, ['config', 'core.autocrlf', 'false']);
  if (options.base !== undefined) {
    await writeIn(root, 'base.txt', options.base);
    await commit(root, 'base');
  }
  if (options.staged !== undefined) {
    await writeIn(root, options.staged.path, options.staged.content);
    await git(root, ['add', options.staged.path]);
  }
  return root;
}

/**
 * Runs the product's own CLI. `execFile` rejects on a non-zero exit, and that exit code is
 * the assertion, so it is returned instead of thrown.
 */
export function orbitree(
  args: readonly string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      CLI,
      [...args],
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 });
          return;
        }
        // `execFile` reports the exit code on the error, and its type does not say so.
        const code = (error as unknown as { code?: number }).code;
        if (typeof code === 'number') {
          resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code });
          return;
        }
        reject(error);
      },
    );
  });
}

export async function writeIn(root: string, path: string, content: string): Promise<void> {
  const full = join(root, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
}

export async function commit(root: string, message: string): Promise<void> {
  await git(root, ['add', '-A']);
  await git(root, ['commit', '--quiet', '-m', message]);
}
