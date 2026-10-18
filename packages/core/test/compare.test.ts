import { writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseComparison } from '../src/git/compare.ts';
import { openRepo, readComparison } from '../src/repo.ts';
import { git } from './support/fixtures.ts';

/**
 * What each side of a fork has, and what neither has.
 *
 * The fixture forks deliberately and then **cherry-picks** one side's work onto the other, because that
 * is the case `--cherry-pick` exists for: two branches with different commits and the same work. A test
 * that only compared diverged histories would pass against a set difference of two hash lists, which is
 * the implementation this one is not.
 */
let root = '';
let beside = '';

beforeEach(async () => {
  beside = await mkdtemp(join(tmpdir(), 'orbitree-compare-'));
  root = join(beside, 'repo');
  await git(beside, 'init', '-b', 'main', '--quiet', root);
  await git(root, 'config', 'core.autocrlf', 'false');
  await git(root, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(root, 'base.txt'), 'the base\n', 'utf8');
  await git(root, 'add', '-A');
  await git(root, 'commit', '--quiet', '-m', 'the base');

  // Left: two commits of its own.
  await git(root, 'checkout', '--quiet', '-b', 'left');
  await writeFile(join(root, 'left.txt'), 'left one\n', 'utf8');
  await git(root, 'add', '-A');
  await git(root, 'commit', '--quiet', '-m', 'only on the left');
  await writeFile(join(root, 'left.txt'), 'left one\nleft two\n', 'utf8');
  await git(root, 'add', '-A');
  await git(root, 'commit', '--quiet', '-m', 'also only on the left');

  // Right: one commit of its own, and one that is the left's first commit, picked across.
  await git(root, 'checkout', '--quiet', 'main');
  await git(root, 'checkout', '--quiet', '-b', 'right');
  await writeFile(join(root, 'right.txt'), 'right one\n', 'utf8');
  await git(root, 'add', '-A');
  await git(root, 'commit', '--quiet', '-m', 'only on the right');
  await git(root, 'cherry-pick', '--quiet', 'left~1');
});

afterEach(async () => {
  await rm(beside, { recursive: true, force: true });
});

describe('a fork, both ways', () => {
  it('[I5] each list is the commits that side only has, and the worked-out ones are in neither', async () => {
    const comparison = await readComparison(await openRepo(root), { left: 'left', right: 'right' });

    // The cherry-picked commit is on the right *and* has a counterpart on the left, so `--cherry-pick`
    // leaves it out of both lists: the branches differ by one commit, not two.
    expect(comparison.onlyLeft.map((commit) => commit.subject)).toEqual(['also only on the left']);
    expect(comparison.onlyRight.map((commit) => commit.subject)).toEqual(['only on the right']);
    expect(comparison.records).toHaveLength(2);

    // git's own answer, read a second way and with the other flag: `--right-only` is the half of the
    // symmetric difference the right side owns. A disagreement here is this parser's and not git's.
    const right = await git(
      root,
      'log',
      '--right-only',
      '--cherry-pick',
      '--format=%H',
      'left...right',
    );
    const left = await git(
      root,
      'log',
      '--left-only',
      '--cherry-pick',
      '--format=%H',
      'left...right',
    );
    expect(comparison.onlyRight.map((commit) => commit.hash)).toEqual(lines(right.stdout));
    expect(comparison.onlyLeft.map((commit) => commit.hash)).toEqual(lines(left.stdout));

    // And the direction is symmetric: swapping the sides swaps the lists, which is the whole of "in
    // both directions".
    const swapped = await readComparison(await openRepo(root), { left: 'right', right: 'left' });
    expect(swapped.onlyLeft.map((commit) => commit.subject)).toEqual(['only on the right']);
    expect(swapped.onlyRight.map((commit) => commit.subject)).toEqual(['also only on the left']);
  });

  it('[I5] a side that is an ancestor has nothing of its own', async () => {
    // `main` is the base of both, so everything it has they have: one direction is empty. The other has
    // both of the right's commits, including the one it picked across from the left — the patch is on
    // the right and on the left, but the *commit* is only on the right, and this comparison is between
    // `main` and `right`, where nothing on the left is in question.
    const comparison = await readComparison(await openRepo(root), { left: 'main', right: 'right' });
    expect(comparison.onlyLeft).toEqual([]);
    expect(comparison.onlyRight.map((commit) => commit.subject)).toEqual([
      'only on the left',
      'only on the right',
    ]);
  });

  it('[I4] a record with no mark is a value, and a limit is a limit', async () => {
    // The mark is the answer, so a record without one is not a commit of unknown side: it is a read
    // this parser cannot answer, and it says so.
    expect(parseComparison('abc123').ok).toBe(false);
    expect(parseComparison('').ok).toBe(true);

    // A record that is only a mark has no commit in it, which is a failure and not an empty commit.
    expect(parseComparison('>\u0000').ok).toBe(false);

    // One commit per side with the fields `parseLog` expects, in the format the parser reads.
    const record = (mark: string, hash: string, subject: string): string =>
      `${mark}${hash}\u001f\u001fSomeone\u001fauthor@example.invalid\u001f1700000000\u001f1700000000\u001f${subject}\u0000`;
    const hashes = ['a'.repeat(40), 'b'.repeat(40)] as const;
    const both = parseComparison(
      record('<', hashes[0], 'left one') + record('>', hashes[1], 'right one'),
    );
    expect(both.ok).toBe(true);
    expect(both.ok && both.value.map((marked) => marked.side)).toEqual(['left', 'right']);
    expect(both.ok && both.value[0]?.commit.subject).toBe('left one');

    // The limit is git's: a window that asks for one commit gets one, and the lists are what it read
    // rather than what a second read would have found.
    const limited = await readComparison(await openRepo(root), {
      left: 'left',
      right: 'right',
      limit: 1,
    });
    expect(limited.records).toHaveLength(1);
  });
});

function lines(output: string): string[] {
  return output.split('\n').filter((line) => line !== '');
}
