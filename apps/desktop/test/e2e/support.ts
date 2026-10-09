/**
 * The e2e suite builds its repositories with the real `git` binary, exactly as the core's
 * fixtures do, and for the same reason: a fixture made by the product would agree with the
 * product's own bug. Nothing here imports `packages/core` — the test's job is to disagree
 * with the app when the app is wrong, so it must not share the app's code.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { type ElectronApplication, _electron as electron, type Page } from '@playwright/test';

const run = promisify(execFile);

export const APP_PATH = join(import.meta.dirname, '..', '..');

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
  options: { readonly userDataDir?: string } = {},
): Promise<AppHandle> {
  const userDataDir = options.userDataDir ?? (await mkdtemp(join(tmpdir(), 'orbitree-userdata-')));
  const app = await electron.launch({
    args: [
      APP_PATH,
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

export async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orbitree-e2e-'));
  await git(root, ['init', '-b', 'main', '--quiet']);
  await git(root, ['config', 'user.name', 'E2E Author']);
  await git(root, ['config', 'user.email', 'e2e@example.invalid']);
  await git(root, ['config', 'commit.gpgsign', 'false']);
  await git(root, ['config', 'core.autocrlf', 'false']);
  return root;
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
