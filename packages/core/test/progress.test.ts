import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execute } from '../src/git/exec.ts';
import { parseProgress, parseProgressLine } from '../src/git/progress.ts';
import { git } from './support/fixtures.ts';

/**
 * git's progress, and the two things that make parsing it different from parsing a porcelain format.
 *
 * It is not a format git promises: the phases are its own wording, the separator is a carriage return
 * so a terminal overwrites one row, and it shares stderr with every error git prints. So the phases
 * are checked rather than guessed, and the test that matters is the one that asks real git for real
 * progress and compares the lines that arrived as they were written with the lines in the text that
 * arrived whole.
 */
let root = '';
let beside = '';

beforeEach(async () => {
  beside = await mkdtemp(join(tmpdir(), 'orbitree-progress-'));
  root = join(beside, 'src');
  await git(beside, 'init', '-b', 'main', '--quiet', root);
  await git(root, 'config', 'user.name', 'Progress Test');
  await git(root, 'config', 'user.email', 'progress@example.invalid');
  await git(root, 'config', 'core.autocrlf', 'false');
  for (let index = 1; index <= 8; index += 1) {
    await git(root, 'commit', '--allow-empty', '--quiet', '-m', `commit ${index}`);
  }
});

afterEach(async () => {
  await rm(beside, { recursive: true, force: true });
});

describe('git’s progress lines', () => {
  it('[I5] the lines that arrive while a fetch runs are the lines of the text it printed', async () => {
    const remote = join(beside, 'remote.git');
    await git(beside, 'init', '--bare', '--quiet', remote);
    await git(root, 'remote', 'add', 'origin', `file://${remote}`);
    await git(root, 'push', '--quiet', 'origin', 'main');

    // A second repository with nothing but the remote, so the fetch has ten objects to receive and
    // git actually reports them. `--progress` is in the argv, which is what makes git write to a pipe
    // at all.
    const reader = join(beside, 'reader');
    await git(beside, 'init', '-b', 'main', '--quiet', reader);
    await git(reader, 'remote', 'add', 'origin', `file://${remote}`);

    const seen: string[] = [];
    const result = await execute(
      { op: 'fetch', remote: 'origin' },
      { cwd: reader, onProgress: (progress) => seen.push(progress.raw) },
    );
    expect(result.exitCode).toBe(0);
    expect(seen.length).toBeGreaterThan(0);

    // Every phase named as it arrived is a phase git actually reported, and the buffered text holds
    // the same lines: the streaming and the whole-text read cannot disagree about what happened.
    const buffered = parseProgress(result.stderr);
    expect(buffered.ok).toBe(true);
    expect(buffered.ok && buffered.value.map((progress) => progress.raw)).toEqual(
      expect.arrayContaining(seen),
    );
    for (const progress of buffered.ok ? buffered.value : []) {
      expect(progress.phase).not.toBe('');
      expect(progress.percent === null || (progress.percent >= 0 && progress.percent <= 100)).toBe(
        true,
      );
    }
    // A receive of ten objects ends by resolving its deltas, and the last line of that phase says so.
    const deltas = seen.filter((line) => line.includes('Resolving deltas')).at(-1);
    if (deltas !== undefined) expect(deltas).toContain('done');
  });

  it('a local read reports nothing, because it has nothing to report', async () => {
    const seen: string[] = [];
    const result = await execute(
      { op: 'status' },
      { cwd: root, onProgress: (p) => seen.push(p.raw) },
    );
    expect(result.exitCode).toBe(0);
    expect(seen).toEqual([]);
  });

  it('[I4] an error is not a phase, and a phase nobody knows is not progress either', () => {
    // The shape is what makes this parser dangerous: `fatal: unable to access …` matches everything a
    // loose `word: text` pattern would, and would be reported as a phase called "fatal".
    expect(
      parseProgressLine(
        "fatal: unable to access 'https://127.0.0.1:9/x.git/': Failed to connect to 127.0.0.1 port 9",
      ),
    ).toBeNull();
    expect(parseProgressLine('remote: error: GH006: Protected branch update failed')).toBeNull();
    expect(parseProgressLine('Some future phase: 50% (1/2)')).toBeNull();
    expect(parseProgressLine('Counting objects: 50% (1/2), 1.20 MiB | 1.10 MiB/s')).toEqual({
      phase: 'Counting objects',
      percent: 50,
      detail: '1.20 MiB | 1.10 MiB/s',
      raw: 'Counting objects: 50% (1/2), 1.20 MiB | 1.10 MiB/s',
    });
    // The `remote:` prefix is git's, not the phase's name, and it is stripped.
    expect(parseProgressLine('remote: Resolving deltas: 100% (500/500), done.')?.phase).toBe(
      'Resolving deltas',
    );
    // A phase that has finished with a count and not a percentage.
    expect(parseProgressLine('Enumerating objects: 4, done.')).toEqual({
      phase: 'Enumerating objects',
      percent: null,
      detail: '4, done.',
      raw: 'Enumerating objects: 4, done.',
    });
    // And a carriage return is how git separates them, so it is not part of the line.
    expect(parseProgressLine('Receiving objects: 100% (10/10)\r')?.raw).toBe(
      'Receiving objects: 100% (10/10)',
    );
  });
});
