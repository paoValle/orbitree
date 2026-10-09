/**
 * The e2e suite builds its repositories with the real `git` binary, exactly as the core's
 * fixtures do, and for the same reason: a fixture made by the product would agree with the
 * product's own bug. Nothing here imports `packages/core` — the test's job is to disagree
 * with the app when the app is wrong, so it must not share the app's code.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const APP_PATH = join(import.meta.dirname, '..', '..');

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
