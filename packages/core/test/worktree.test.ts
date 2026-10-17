import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execute } from '../src/git/exec.ts';
import { parseWorktrees } from '../src/git/worktree.ts';
import { openRepo, readWorktrees } from '../src/repo.ts';
import { git } from './support/fixtures.ts';

/**
 * Worktrees: the same repository in more than one directory.
 *
 * The assertions are git's own answers where they can be — `git worktree list` read a second way —
 * because a parser confirmed by its own output is a parser nobody checked.
 */
let root = '';
let beside = '';

beforeEach(async () => {
  beside = await mkdtemp(join(tmpdir(), 'orbitree-worktrees-'));
  root = join(beside, 'main');
  await git(beside, 'init', '-b', 'main', '--quiet', root);
  await git(root, 'config', 'core.autocrlf', 'false');
  await git(root, 'config', 'commit.gpgsign', 'false');
  await git(root, 'commit', '--allow-empty', '--quiet', '-m', 'the first commit');
});

afterEach(async () => {
  await rm(beside, { recursive: true, force: true });
});

describe('the worktrees a repository has', () => {
  it('[I5] reads the one the read happened in, and git agrees there is one', async () => {
    const repo = await openRepo(root);
    const worktrees = await readWorktrees(repo);

    expect(worktrees).toHaveLength(1);
    const only = worktrees[0];
    // The path git prints is the real one, which on a Mac is not the temporary one.
    expect(only?.path.endsWith(basename(root))).toBe(true);
    expect(only?.branch).toBe('main');
    expect(only?.detached).toBe(false);
    expect(only?.bare).toBe(false);

    // The cross-check: `--porcelain` has one shape and the plumbing another, and they have to agree
    // about how many there are.
    const lines = await git(root, 'worktree', 'list');
    expect(lines.stdout.trim().split('\n')).toHaveLength(1);
    // And the head the parser kept is the commit real git reports.
    const head = await git(root, 'rev-parse', 'HEAD');
    expect(only?.head).toBe(head.stdout.trim());
  });

  it('[I5] a second working directory is listed, with its own branch', async () => {
    const second = join(beside, 'second');
    const added = await execute(
      { op: 'worktree-add', path: second, branch: 'side' },
      { cwd: root },
    );
    // `side` does not exist yet, so this is git refusing rather than the product inventing a branch.
    expect(added.exitCode).not.toBe(0);

    await git(root, 'branch', 'side');
    const ok = await execute({ op: 'worktree-add', path: second, branch: 'side' }, { cwd: root });
    expect(ok.exitCode).toBe(0);

    const worktrees = await readWorktrees(await openRepo(root));
    expect(worktrees).toHaveLength(2);
    const on = worktrees.find((entry) => entry.branch === 'side');
    // Git resolves the path it was given, and on a Mac that is the difference between `/var` and
    // `/private/var`: the assertion is about which directory it is, not about how it is spelled.
    expect(on?.path.endsWith('/second')).toBe(true);
    // Both working directories are one repository: the commit is the same one.
    expect(on?.head).toBe((await git(root, 'rev-parse', 'side')).stdout.trim());

    // Removing it is the reverse, and the list goes back to one.
    const removed = await execute({ op: 'worktree-remove', path: second }, { cwd: root });
    expect(removed.exitCode).toBe(0);
    expect(await readWorktrees(await openRepo(root))).toHaveLength(1);
  });

  it('[I4] a block it cannot read is a value, not an exception', () => {
    expect(parseWorktrees('HEAD 0000\n').ok).toBe(false);
    expect(parseWorktrees('worktree /tmp/x\nHEAD not-a-hash\n').ok).toBe(false);
    // An unknown key is data: the block is kept whole, which is what makes a newer git's output
    // readable by an older product instead of fatal.
    const parsed = parseWorktrees('worktree /tmp/x\nHEAD ' + 'a'.repeat(40) + '\nfuture thing\n');
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value[0]?.raw).toContain('future thing');
    const empty = parseWorktrees('');
    expect(empty.ok ? empty.value : null).toEqual([]);
  });
});
