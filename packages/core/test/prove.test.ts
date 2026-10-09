/**
 * `make prove` — the numbers the README claims, measured now.
 *
 * This file exists because a claim in a README is a liability until a command produces it.
 * Every line printed as `[prove]` is a count that came from a real run: real `git`, real
 * repositories, real random histories. Nothing here asserts a constant.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { assertSafeRef, InvalidArgumentError, toArgv } from '../src/git/command.ts';
import { gitVersion, meetsMinimumGitVersion } from '../src/git/exec.ts';
import type { Commit } from '../src/git/log.ts';
import { redact } from '../src/git/redact.ts';
import { layoutGraph } from '../src/graph/layout.ts';
import { openRepo, readGraph, readStatus } from '../src/repo.ts';
import { findStatusMismatches } from './support/crosscheck.ts';
import { type FixtureSet, makeFixtures } from './support/fixtures.ts';
import { layoutViolations } from './support/graph-invariants.ts';

const measured: [string, string | number][] = [];

function prove(label: string, value: string | number): void {
  measured.push([label, value]);
  console.log(`[prove] ${label} = ${value}`);
}

describe('what this build can prove, by running it', () => {
  it('measures the parsers against real repositories and real histories', async () => {
    let fixtures: FixtureSet | null = null;
    try {
      fixtures = await makeFixtures();
      const version = await gitVersion(process.cwd());
      prove('git', version);
      prove('git is new enough for the product', meetsMinimumGitVersion(version) ? 'yes' : 'no');
      prove('platform', `${process.platform}/${process.arch}`);
      prove('node', process.version);

      let entryCount = 0;
      let mismatchCount = 0;
      let dirty = 0;
      const kinds = new Set<string>();
      const heads = new Set<string>();
      for (const fixture of fixtures.fixtures) {
        const repo = await openRepo(fixture.root);
        const state = await readStatus(repo);
        entryCount += state.entries.length;
        heads.add(state.head.kind);
        if (state.entries.length > 0) dirty += 1;
        for (const entry of state.entries) kinds.add(entry.kind);
        mismatchCount += (await findStatusMismatches(fixture.root, state)).length;
      }
      prove('repositories built with the real git binary', fixtures.fixtures.length);
      prove('of those, with changes to read', dirty);
      prove('working-tree entries parsed', entryCount);
      prove('working-tree entry kinds covered', [...kinds].sort().join(', '));
      prove('head kinds covered', [...heads].sort().join(', '));
      prove('disagreements with rev-parse/symbolic-ref/ls-files/porcelain-v1', mismatchCount);
      expect(mismatchCount).toBe(0);
      // State coverage, not a count: if a fixture stopped producing a conflict, or a
      // rename, the number of entries might not move and the suite would go quiet.
      expect([...kinds].sort()).toEqual(['ordinary', 'renamed', 'unmerged', 'untracked']);
      expect([...heads].sort()).toEqual(['branch', 'detached', 'unborn']);
    } finally {
      await fixtures?.cleanup();
    }
  }, 120_000);

  it('measures the graph layout on random histories', () => {
    const runs = 500;
    // Seeded on purpose: the README quotes these counts, and a claim that changes on every run
    // is not a claim. The unseeded version of this property lives in layout.test.ts, where the
    // numbers are not published.
    const seed = 20261009;
    let commits = 0;
    let violations = 0;
    let lanes = 0;
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 40 }).chain((count) => {
          if (count < 2) {
            return fc.constant<readonly Commit[]>([
              {
                hash: 'c0',
                parents: [],
                author: { name: 'p', email: 'p@e' },
                authoredAt: 0,
                committedAt: 0,
                subject: 's',
              },
            ]);
          }
          return fc
            .array(
              fc.tuple(
                fc.integer({ min: 0, max: count - 1 }),
                fc.integer({ min: 0, max: count - 1 }),
              ),
              { maxLength: count * 2 },
            )
            .map((arcs) => {
              const parents: Set<number>[] = Array.from({ length: count }, () => new Set<number>());
              for (const [a, b] of arcs) {
                const child = Math.min(a, b);
                const parent = Math.max(a, b);
                const slot = parents[child];
                if (child !== parent && slot !== undefined && slot.size < 4) slot.add(parent);
              }
              return parents.map(
                (slot, index): Commit => ({
                  hash: `c${index}`,
                  parents: [...slot].sort((left, right) => left - right).map((p) => `c${p}`),
                  author: { name: 'p', email: 'p@e' },
                  authoredAt: 0,
                  committedAt: 0,
                  subject: `commit ${index}`,
                }),
              );
            });
        }),
        (history) => {
          const layout = layoutGraph(history);
          commits += history.length;
          lanes += layout.laneCount;
          violations += layoutViolations(history, layout).length;
          return true;
        },
      ),
      { numRuns: runs, seed },
    );
    prove('random histories laid out', runs);
    prove('commits placed', commits);
    prove('lanes used, in total', lanes);
    prove('invariant violations', violations);
    expect(violations).toBe(0);
    expect(commits).toBeGreaterThan(runs);
  });

  it('measures the guards', () => {
    const refused = ['-x', '--upload-pack=t', 'a b', '', 'a\u0000b'].filter((ref) => {
      try {
        assertSafeRef(ref);
        return false;
      } catch (error) {
        return error instanceof InvalidArgumentError;
      }
    }).length;
    const accepted = ['HEAD', 'HEAD~1', 'main', 'main..feature', 'v1.0.0'].filter((ref) => {
      try {
        assertSafeRef(ref);
        return true;
      } catch {
        return false;
      }
    }).length;
    prove('refs refused as argument injection', refused);
    prove('real revisions still accepted', accepted);
    expect(refused).toBe(5);
    expect(accepted).toBe(5);

    const argv = toArgv({ op: 'add', paths: ['-n', 'a b.txt', '$(touch pwned)'] });
    prove('argv for a hostile path list', argv.join(' '));
    expect(argv.slice(0, 2)).toEqual(['add', '--']);

    const secrets = [
      'https://user:tok3n@github.com/a/b.git',
      'ghp_ABCDEFGHIJKLMNOPQRST',
      'glpat-abcdefghijklmnopqrst',
      'Authorization: Bearer abcdefghijklmnop',
    ];
    const leaked = secrets.filter((secret) => redact(secret).includes(secret));
    prove('secret samples that survive redaction', leaked.length);
    expect(leaked).toEqual([]);
  });

  it('measures this repository, read by the product itself', async () => {
    const repo = await openRepo(process.cwd());
    const state = await readStatus(repo);
    const graph = await readGraph(repo, { limit: 200, all: true });
    prove('HEAD kind', state.head.kind);
    prove('commits read from this repository', graph.commits.length);
    prove('lanes used by this repository', graph.layout.laneCount);
    prove('refs', graph.refs.length);
    expect(graph.layout.rows.length).toBe(graph.commits.length);
  });

  it('the README’s claims table is printed above', () => {
    expect(measured.length).toBeGreaterThanOrEqual(15);
  });
});
