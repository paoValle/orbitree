import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Commit } from '../src/git/log.ts';
import { visibleCommits } from '../src/graph/visible.ts';

/**
 * What a picture holds when a name is hidden.
 *
 * The property that matters is reachability: hiding a tip while keeping its ancestors would leave
 * lines going down to nothing. So the cases below are about *what is left*, not about what was
 * removed, and one of them is generated, because a DAG written by hand only holds the shapes
 * somebody thought of.
 */
const commit = (hash: string, parents: readonly string[]): Commit => ({
  hash,
  parents,
  author: { name: 'A', email: 'a@example.invalid' },
  authoredAt: 0,
  committedAt: 0,
  subject: hash,
});

/** `main: a → b → root`, `feature: c → b`, and a third branch off the root. */
const commits: readonly Commit[] = [
  commit('a', ['b']),
  commit('c', ['b']),
  commit('b', ['root']),
  commit('d', ['root']),
  commit('root', []),
];

const hashes = (kept: readonly Commit[]): readonly string[] =>
  kept.map((entry) => entry.hash).sort();

describe('the commits a picture holds', () => {
  it('[I6] keeps every commit a visible name can reach', () => {
    expect(hashes(visibleCommits(commits, ['a', 'c']))).toEqual(['a', 'b', 'c', 'root']);
  });

  it('[I6] hiding a name drops what only it can reach, and nothing else', () => {
    // `c` is only reachable from the feature branch, so hiding that branch takes `c` and leaves the
    // rest of the history exactly where it was — including `b`, which both names share.
    expect(hashes(visibleCommits(commits, ['a']))).toEqual(['a', 'b', 'root']);
    // ...and the third branch off the root goes when nothing reaches it either.
    expect(hashes(visibleCommits(commits, ['a', 'c']))).not.toContain('d');
    // `d` is a branch of its own off the root, so keeping only it keeps `d` and the root: `b` is
    // reachable from the two branches above, and neither of them is visible here.
    expect(hashes(visibleCommits(commits, ['d']))).toEqual(['d', 'root']);
  });

  it('[I6] a tip outside the window is normal, not an error', () => {
    // The window is a page of a longer history: a name whose tip is on another page is simply a
    // tip nothing in this commit list can be reached from.
    expect(visibleCommits(commits, ['not-here'])).toEqual([]);
    expect(hashes(visibleCommits(commits, ['not-here', 'd']))).toEqual(['d', 'root']);
  });

  it('[I6] holds for any DAG and any subset of tips, and never invents a commit', () => {
    const dags = fc
      .array(
        fc.record({
          parents: fc.array(fc.integer({ min: 0, max: 7 }), { maxLength: 2 }),
        }),
        { minLength: 1, maxLength: 8 },
      )
      .map((raw) =>
        raw.map((entry, index) => ({
          ...commit(`c${index}`, []),
          // Only backwards edges, so the result is a DAG: a parent is always a later commit.
          parents: entry.parents
            .map((parent) => `c${Math.max(index + 1, parent)}`)
            .filter((parent) => parent !== `c${index}`),
        })),
      );

    fc.assert(
      fc.property(dags, fc.array(fc.integer({ min: 0, max: 7 }), { maxLength: 3 }), (dag, tips) => {
        const byHash = new Map(dag.map((entry) => [entry.hash, entry]));
        const kept = visibleCommits(
          dag,
          tips.map((index) => `c${index}`),
        );
        const keptHashes = new Set(kept.map((entry) => entry.hash));

        // Nothing invented, nothing lost from the input without a reason.
        for (const entry of kept) expect(byHash.has(entry.hash)).toBe(true);
        // Closed under parents *within the window*: a drawn commit never points at a dropped one
        // that is in the window, which is the line to nowhere this function exists to prevent.
        for (const entry of kept) {
          for (const parent of entry.parents) {
            if (byHash.has(parent)) expect(keptHashes.has(parent)).toBe(true);
          }
        }
        // And every commit kept is reachable from a tip that was given — recomputed here, from the
        // parents, rather than asked of the function being tested.
        const fromTips = new Set<string>();
        const queue = tips.map((index) => `c${index}`);
        while (queue.length > 0) {
          const hash = queue.pop() as string;
          if (fromTips.has(hash) || !byHash.has(hash)) continue;
          fromTips.add(hash);
          for (const parent of byHash.get(hash)?.parents ?? []) queue.push(parent);
        }
        for (const entry of kept) expect(fromTips.has(entry.hash)).toBe(true);
        for (const entry of dag) {
          if (fromTips.has(entry.hash)) expect(keptHashes.has(entry.hash)).toBe(true);
        }
      }),
    );
  });
});
