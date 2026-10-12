import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCommitCount } from '../src/git/count.ts';
import { openRepo, readGraph } from '../src/repo.ts';
import { type FixtureSet, git, makeFixtures } from './support/fixtures.ts';

let set: FixtureSet;

beforeAll(async () => {
  set = await makeFixtures();
});

afterAll(async () => {
  await set?.cleanup();
});

function fixtureRoot(name: string): string {
  const fixture = set.fixtures.find((candidate) => candidate.name === name);
  if (fixture === undefined) throw new Error(`the ${name} fixture is missing`);
  return fixture.root;
}

describe('the window against the whole history', () => {
  it('[I5] the commit count agrees with git with and without --all', async () => {
    const root = fixtureRoot('history');
    const repo = await openRepo(root);

    const head = await git(root, 'rev-list', '--count', 'HEAD');
    const all = await git(root, 'rev-list', '--count', '--all');
    const headOnly = await readGraph(repo, { limit: 1000 });
    const everything = await readGraph(repo, { limit: 1000, all: true });

    expect(headOnly.total).toBe(Number.parseInt(head.stdout.trim(), 10));
    expect(everything.total).toBe(Number.parseInt(all.stdout.trim(), 10));
    // `--all` reaches commits HEAD cannot on this fixture, so an argv missing the flag
    // would disagree here instead of passing on a repository where the two numbers match.
    expect(everything.total).toBeGreaterThan(headOnly.total);
  });

  it('[I5] a named revision reads that branch, and its total matches git', async () => {
    const root = fixtureRoot('history');
    const repo = await openRepo(root);

    // `feature-b` is not reachable from the detached working revision: it holds a commit
    // HEAD cannot see. A `rev` that was dropped between the log and the count would then
    // return the wrong commits, or a total from the wrong history.
    const tip = (await git(root, 'rev-parse', 'feature-b')).stdout.trim();
    const otherTip = (await git(root, 'rev-parse', 'feature-a')).stdout.trim();
    const expected = Number.parseInt(
      (await git(root, 'rev-list', '--count', 'feature-b')).stdout.trim(),
      10,
    );
    const all = Number.parseInt(
      (await git(root, 'rev-list', '--count', '--all')).stdout.trim(),
      10,
    );
    const reachable = new Set(
      (await git(root, 'rev-list', 'feature-b')).stdout.split('\n').filter((line) => line !== ''),
    );

    const graph = await readGraph(repo, { limit: 1000, rev: 'feature-b' });
    expect(graph.total).toBe(expected);
    // The same revision differs from the whole repository, so this is not `--all` by luck.
    expect(graph.total).not.toBe(all);
    expect(graph.commits.length).toBe(expected);
    expect(graph.commits.some((commit) => commit.hash === tip)).toBe(true);
    // Every returned commit is in the named branch, and the tip of the other branch is not:
    // the read history is exactly the one asked for.
    for (const commit of graph.commits) expect(reachable.has(commit.hash)).toBe(true);
    expect(graph.commits.some((commit) => commit.hash === otherTip)).toBe(false);
  });

  it('[I5] truncated is true exactly when the window cut the history', async () => {
    const repo = await openRepo(fixtureRoot('history'));

    const full = await readGraph(repo, { limit: 1000 });
    expect(full.total).toBeGreaterThan(1);
    expect(full.truncated).toBe(false);
    expect(full.commits.length).toBe(full.total);

    const cut = await readGraph(repo, { limit: 1 });
    expect(cut.commits.length).toBe(1);
    expect(cut.truncated).toBe(true);
    expect(cut.total).toBe(full.total);
  });
});

describe('the count parser', () => {
  it('[I4] a count that is not a number is a value, never an exception', async () => {
    const broken = ['', '  ', 'abc', '12 commits', '1 2', '-3', '3.5', '\u0000', 'HEAD', '12\n13'];
    for (const record of broken) {
      const parsed = parseCommitCount(record);
      expect(parsed.ok, JSON.stringify(record)).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.length).toBeGreaterThan(0);
        expect(parsed.record).toBe(record);
      }
    }
    expect(parseCommitCount('2053\n')).toEqual({ ok: true, value: 2053 });

    // Byte mutations of real output: the parser must answer, not crash.
    const raw = (await git(fixtureRoot('history'), 'rev-list', '--count', '--all')).stdout;
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat({ max: 64 }), fc.integer({ min: 0, max: 255 })), {
          maxLength: 16,
        }),
        (mutations) => {
          const bytes = Buffer.from(raw, 'utf8');
          if (bytes.length === 0) return true;
          for (const [position, value] of mutations) bytes[position % bytes.length] = value;
          const parsed = parseCommitCount(bytes.toString('utf8'));
          return typeof parsed.ok === 'boolean';
        },
      ),
      { numRuns: 200 },
    );
  });
});
