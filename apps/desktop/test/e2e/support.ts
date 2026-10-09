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
import { type ElectronApplication, _electron as electron } from '@playwright/test';

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

export async function closeApp(handle: AppHandle, options: CloseOptions = {}): Promise<void> {
  await handle.app.close();
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
