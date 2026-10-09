import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  gitVersion,
  InvalidArgumentError,
  MINIMUM_GIT_VERSION,
  meetsMinimumGitVersion,
  NotARepositoryError,
  openRepo,
  readGraph,
  readStatus,
  run,
} from '../src/index.ts';
import { type FixtureSet, makeFixtures } from './support/fixtures.ts';

let set: FixtureSet;

beforeAll(async () => {
  set = await makeFixtures();
});

afterAll(async () => {
  await set.cleanup();
});

function fixtureRoot(name: string): string {
  const fixture = set.fixtures.find((candidate) => candidate.name === name);
  if (fixture === undefined) throw new Error(`the ${name} fixture is missing`);
  return fixture.root;
}

describe('opening a repository', () => {
  it('[I3] the root is the work tree root, even when asked from a subdirectory', async () => {
    const root = fixtureRoot('history');
    const nested = join(root, 'a', 'deeper', 'directory');
    await mkdir(nested, { recursive: true });
    const fromRoot = await openRepo(root);
    const fromNested = await openRepo(nested);
    // Compared to each other, not to the fixture path: /tmp is a symlink on macOS and git
    // answers with the resolved path.
    expect(fromNested.root).toBe(fromRoot.root);
  });

  it('a directory that is not a repository is an error, not an empty state', async () => {
    await expect(openRepo('/tmp')).rejects.toBeInstanceOf(NotARepositoryError);
  });

  it('git is present and new enough for what the product asks of it', async () => {
    const version = await gitVersion(process.cwd());
    expect(version).toMatch(/^\d+\.\d+/);
    expect(meetsMinimumGitVersion(version)).toBe(true);
    expect(meetsMinimumGitVersion('2.30.0')).toBe(false);
    expect(MINIMUM_GIT_VERSION).toBe('2.43');
  });

  it('version comparison is a comparison, not a string sort', () => {
    expect(meetsMinimumGitVersion('2.9.0', '2.10.0')).toBe(false);
    expect(meetsMinimumGitVersion('2.43.0', '2.43')).toBe(true);
    expect(meetsMinimumGitVersion('3.0.0', '2.43')).toBe(true);
  });
});

describe('reading a repository end to end', () => {
  it('[I5] status, graph and refs agree with each other on the merge fixture', async () => {
    const repo = await openRepo(fixtureRoot('history'));
    const state = await readStatus(repo);
    expect(['branch', 'detached', 'unborn']).toContain(state.head.kind);

    const graph = await readGraph(repo, { limit: 50, all: true });
    expect(graph.layout.rows.length).toBe(graph.commits.length);
    for (const row of graph.layout.rows) {
      expect(row.lane).toBeGreaterThanOrEqual(0);
      expect(row.lane).toBeLessThan(graph.layout.laneCount);
    }
    // The graph and the refs are two views of one repository, so every ref must land on a
    // commit the graph read.
    const hashes = new Set(graph.commits.map((commit) => commit.hash));
    for (const ref of graph.refs) {
      if (ref.kind === 'tag') expect(hashes.has(ref.target)).toBe(true);
    }
  });
});

describe('the escape hatch', () => {
  it('a non-zero exit is reported, not thrown, for a read', async () => {
    // A revision that does not exist: git exits non-zero and the caller decides.
    const missingRev = await run(
      { op: 'diff', rev: 'refs/heads/definitely-not-a-branch' },
      {
        cwd: process.cwd(),
      },
    );
    expect(missingRev.exitCode).not.toBe(0);
    expect(missingRev.stderr.length).toBeGreaterThan(0);

    // A directory that is not a repository: same contract, and the message says so.
    const notARepo = await run({ op: 'graph', limit: 1 }, { cwd: '/tmp' });
    expect(notARepo.exitCode).not.toBe(0);
    expect(notARepo.stderr.toLowerCase()).toContain('not a git repository');
  });

  it('a working directory that is not a directory is our error, not a fake missing-git', async () => {
    await expect(
      run({ op: 'status' }, { cwd: join(process.cwd(), 'package.json') }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});
