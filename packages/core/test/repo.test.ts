import { describe, expect, it } from 'vitest';
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

describe('opening a repository', () => {
  it('[I3] the root is the work tree root, even when asked from a subdirectory', async () => {
    const here = process.cwd();
    const repo = await openRepo(here);
    expect(repo.root).toBe(here);
    // `packages` is a real subdirectory of this repository: the answer must not change.
    const nested = await openRepo(`${here}/packages`);
    expect(nested.root).toBe(here);
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

describe('reading this repository', () => {
  it('[I5] the project reads its own history and its own working tree', async () => {
    const repo = await openRepo(process.cwd());
    const state = await readStatus(repo);
    expect(['branch', 'detached', 'unborn']).toContain(state.head.kind);

    const graph = await readGraph(repo, { limit: 50, all: true });
    expect(graph.layout.rows.length).toBe(graph.commits.length);
    for (const row of graph.layout.rows) {
      expect(row.lane).toBeGreaterThanOrEqual(0);
      expect(row.lane).toBeLessThan(graph.layout.laneCount);
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
      run({ op: 'status' }, { cwd: `${process.cwd()}/package.json` }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});
