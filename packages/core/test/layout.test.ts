import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Commit } from '../src/git/log.ts';
import { layoutGraph, NotTopologicallySortedError, refsByOid } from '../src/graph/layout.ts';
import { openRepo, readGraph, readStatus } from '../src/repo.ts';
import { type FixtureSet, makeFixtures } from './support/fixtures.ts';
import { isDeterministic, layoutViolations } from './support/graph-invariants.ts';

let set: FixtureSet;

beforeAll(async () => {
  set = await makeFixtures();
});

afterAll(async () => {
  await set?.cleanup();
});

/**
 * Random histories: `count` commits in topological order, with random parent arcs drawn
 * only to later rows. That is exactly the shape `git log --topo-order` produces, including
 * the merge commits and the roots, so the layout is exercised on the same distribution it
 * will meet in a real repository.
 */
function randomHistory(minCount: number, maxCount: number): fc.Arbitrary<readonly Commit[]> {
  return fc.integer({ min: minCount, max: maxCount }).chain((count) => {
    if (count < 2) return fc.constant<readonly Commit[]>([commit(0, [])]);
    const arcs = fc.array(
      fc.tuple(fc.integer({ min: 0, max: count - 1 }), fc.integer({ min: 0, max: count - 1 })),
      { maxLength: count * 2 },
    );
    return arcs.map((pairs) => {
      const parents: Set<number>[] = Array.from({ length: count }, () => new Set<number>());
      for (const [a, b] of pairs) {
        const child = Math.min(a, b);
        const parent = Math.max(a, b);
        const slot = parents[child];
        // A commit has few parents in practice; four is already a rare octopus merge.
        if (child !== parent && slot !== undefined && slot.size < 4) slot.add(parent);
      }
      return parents.map((slot, index) =>
        commit(
          index,
          [...slot].sort((left, right) => left - right),
        ),
      );
    });
  });
}

function commit(index: number, parentIndexes: readonly number[]): Commit {
  return {
    hash: `c${index}`,
    parents: parentIndexes.map((parent) => `c${parent}`),
    author: { name: 'Fixture', email: 'fixture@example.invalid' },
    authoredAt: 0,
    committedAt: 0,
    subject: `commit ${index}`,
  };
}

describe('the graph layout', () => {
  it('[I6] every invariant holds on a thousand random histories', () => {
    fc.assert(
      fc.property(randomHistory(1, 26), (commits) => {
        const problems = layoutViolations(commits, layoutGraph(commits));
        // Thrown, not returned: fast-check then prints the counterexample *with* the
        // invariant that broke, which is the only part worth reading.
        if (problems.length > 0)
          throw new Error(`history of ${commits.length}: ${problems.join('; ')}`);
        return true;
      }),
      { numRuns: 1000 },
    );
  });

  it('[I6] the layout is a pure function of the input', () => {
    fc.assert(
      fc.property(randomHistory(2, 30), (commits) => isDeterministic(commits)),
      { numRuns: 200 },
    );
  });

  it('[I6] a window cut mid-history is still drawn without inventing lines', () => {
    fc.assert(
      fc.property(randomHistory(4, 30), fc.integer({ min: 1, max: 10 }), (commits, cut) => {
        const window = commits.slice(0, Math.max(1, commits.length - cut));
        const problems = layoutViolations(window, layoutGraph(window));
        if (problems.length > 0) throw new Error(problems.join('; '));
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it('a merge puts the two branches on two lanes and joins them', () => {
    const commits: Commit[] = [
      { ...commit(0, []), hash: 'merge', parents: ['left', 'right'] },
      { ...commit(1, []), hash: 'left', parents: ['root'] },
      { ...commit(2, []), hash: 'right', parents: ['root'] },
      { ...commit(3, []), hash: 'root', parents: [] },
    ];
    const layout = layoutGraph(commits);
    expect(layout.laneCount).toBe(2);
    expect(layout.rows[0]?.lane).toBe(0);
    expect(layout.rows[0]?.outgoing).toEqual([0, 1]);
    expect(layout.rows[1]?.lane).toBe(0);
    expect(layout.rows[2]?.lane).toBe(1);
    expect(layout.rows[2]?.through).toEqual([0]);
    // The two branches come back together at the root, in the first lane.
    expect(layout.rows[3]?.lane).toBe(0);
    expect(layout.rows[3]?.incoming).toEqual([1]);
    expect(layout.edges.map((edge) => `${edge.childRow}:${edge.parentIndex}`).sort()).toEqual([
      '0:0',
      '0:1',
      '1:0',
      '2:0',
    ]);
  });

  it('a history that is not topologically sorted is refused, not drawn wrongly', () => {
    const child: Commit = { ...commit(0, []), hash: 'child', parents: ['parent'] };
    const parent: Commit = { ...commit(1, []), hash: 'parent', parents: [] };
    // `git log --topo-order` never does this; a caller that ignores the order gets a loud
    // failure instead of a line that goes upwards.
    expect(() => layoutGraph([parent, child])).toThrow(NotTopologicallySortedError);
    expect(() => layoutGraph([child, child])).toThrow(NotTopologicallySortedError);
    expect(() => layoutGraph([child, parent])).not.toThrow();
  });
});

describe('the graph of a real repository', () => {
  it('[I5] the history fixture is laid out, and its tag is on the right commit', async () => {
    const fixture = set.fixtures.find((candidate) => candidate.name === 'history');
    if (fixture === undefined) throw new Error('the history fixture is missing');
    const repo = await openRepo(fixture.root);
    const graph = await readGraph(repo, { limit: 100, all: true });

    expect(layoutViolations(graph.commits, graph.layout)).toEqual([]);
    expect(graph.commits.length).toBeGreaterThanOrEqual(6);
    expect(graph.layout.laneCount).toBeGreaterThanOrEqual(2);
    expect(graph.layout.rows.length).toBe(graph.commits.length);

    const tag = graph.refs.find((ref) => ref.shortName === 'v1');
    expect(tag).toBeDefined();
    const tagged = graph.layout.rows.find((row) => row.commit.hash === tag?.target);
    expect(tagged).toBeDefined();
    expect(graph.refsByOid.get(tag?.target ?? '')?.map((ref) => ref.shortName)).toContain('v1');
    // The badge list puts the current branch first.
    const head = graph.refs.find((ref) => ref.isHead);
    if (head !== undefined) {
      const badges = graph.refsByOid.get(head.target) ?? [];
      expect(badges[0]?.isHead).toBe(true);
    }
  });

  it('[I5] a detached head is reported by the status, and the branch is not marked as head', async () => {
    const fixture = set.fixtures.find((candidate) => candidate.name === 'history');
    if (fixture === undefined) throw new Error('the history fixture is missing');
    const repo = await openRepo(fixture.root);
    const state = await readStatus(repo);
    expect(state.head.kind).toBe('detached');
    const graph = await readGraph(repo, { limit: 5, all: true });
    // `git for-each-ref` does not list HEAD, so "where am I" comes from the status and
    // never from guessing at a ref name.
    expect(graph.refs.some((ref) => ref.isHead)).toBe(false);
    expect(graph.refs.some((ref) => ref.shortName === 'HEAD')).toBe(false);
  });

  it('refs are grouped and ordered: HEAD, then branches', () => {
    const refs = [
      {
        name: 'refs/remotes/origin/main',
        shortName: 'origin/main',
        kind: 'remote',
        target: 'a',
        isHead: false,
        upstream: null,
        symref: null,
      },
      {
        name: 'refs/heads/main',
        shortName: 'main',
        kind: 'branch',
        target: 'a',
        isHead: true,
        upstream: 'origin/main',
        symref: null,
      },
      {
        name: 'refs/tags/v1',
        shortName: 'v1',
        kind: 'tag',
        target: 'a',
        isHead: false,
        upstream: null,
        symref: null,
      },
    ];
    const grouped = refsByOid(refs);
    expect(grouped.get('a')?.map((ref) => ref.shortName)).toEqual(['main', 'origin/main', 'v1']);
  });
});
