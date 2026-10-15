import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '../src/git/exec.ts';
import { git } from './support/fixtures.ts';

/**
 * Discarding one hunk is the only operation in the product whose input is not an argument: the
 * executor reads the file's own diff and feeds the patch for that one hunk to `git apply
 * --reverse`. So the test is about what git does with it, on a real repository — a patch composed
 * wrongly is a patch git refuses, or worse, one it applies to the wrong lines.
 *
 * The fixture is built here rather than shared because it gets rewritten by every test: a
 * repository that two test files mutate is a repository that fails for reasons of its own.
 */
let root = '';

const fortyLines = (changed: boolean): string => {
  const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
  if (changed) {
    lines[1] = 'CHANGED 2';
    lines[25] = 'CHANGED 26';
  }
  return `${lines.join('\n')}\n`;
};

const writeFortyLines = (changed: boolean): Promise<void> =>
  writeFile(join(root, 'f.txt'), fortyLines(changed), 'utf8');

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'orbitree-hunk-'));
  await git(root, 'init', '-b', 'main', '--quiet');
  await writeFortyLines(false);
  await git(root, 'add', '-A');
  await git(root, 'commit', '--quiet', '-m', 'forty lines');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A reason, which every destructive operation needs before it will run. */
const reason = {
  confirmedBy: 'test',
  reason: 'the second line was a mistake',
  at: '2026-01-01T00:00:00.000Z',
};

describe('discarding one hunk', () => {
  it('[I5] reverses that hunk and leaves the other one alone', async () => {
    await writeFortyLines(true);
    // Two hunks, far enough apart that git prints them separately. With one hunk this test would
    // pass whatever the index meant, which is the mistake it exists to catch.
    const diff = await git(root, 'diff', '--', 'f.txt');
    expect(diff.stdout.match(/^@@/gm)).toHaveLength(2);

    const result = await execute(
      { op: 'discard-hunk', path: 'f.txt', hunk: 0 },
      { cwd: root, confirmation: reason },
    );
    expect(result.exitCode).toBe(0);

    const lines = (await readFile(join(root, 'f.txt'), 'utf8')).split('\n');
    expect(lines[1]).toBe('line 2');
    expect(lines[25]).toBe('CHANGED 26');
  });

  it('[I5] the second hunk is the other one, not the first one over again', async () => {
    await writeFortyLines(true);
    const result = await execute(
      { op: 'discard-hunk', path: 'f.txt', hunk: 1 },
      { cwd: root, confirmation: reason },
    );
    expect(result.exitCode).toBe(0);

    const lines = (await readFile(join(root, 'f.txt'), 'utf8')).split('\n');
    expect(lines[1]).toBe('CHANGED 2');
    expect(lines[25]).toBe('line 26');
  });

  it('[I1] refuses without a reason, and nothing has moved', async () => {
    await writeFortyLines(true);
    await expect(
      execute({ op: 'discard-hunk', path: 'f.txt', hunk: 0 }, { cwd: root }),
    ).rejects.toThrow(/confirmation/i);
    expect((await readFile(join(root, 'f.txt'), 'utf8')).split('\n')[1]).toBe('CHANGED 2');
  });

  it('names a hunk that is not there instead of running something else', async () => {
    await writeFortyLines(true);
    await expect(
      execute({ op: 'discard-hunk', path: 'f.txt', hunk: 9 }, { cwd: root, confirmation: reason }),
    ).rejects.toThrow(/hunk 9/);
    await expect(
      execute(
        { op: 'discard-hunk', path: 'nothing.txt', hunk: 0 },
        { cwd: root, confirmation: reason },
      ),
    ).rejects.toThrow(/no uncommitted change/);
  });
});
