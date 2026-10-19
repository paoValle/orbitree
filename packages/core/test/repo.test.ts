import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type DiffFile,
  gitVersion,
  MINIMUM_GIT_VERSION,
  meetsMinimumGitVersion,
  NotARepositoryError,
  openRepo,
  PathNotFoundError,
  readDiff,
  readGraph,
  readStatus,
  run,
} from '../src/index.ts';
import { presetPath } from '../src/config.ts';
import { type FixtureSet, git, makeFixtures } from './support/fixtures.ts';
import { parseNumstat } from './support/patch-crosscheck.ts';

let set: FixtureSet;
/**
 * A directory that exists everywhere and is not a repository.
 *
 * Both tests below used `/tmp`, which is not a path on Windows at all, so the guard refused the
 * working directory before git could be asked anything and the tests failed for a reason that had
 * nothing to do with what they assert.
 */
let notARepository = '';

beforeAll(async () => {
  set = await makeFixtures();
  notARepository = join(dirname(fixtureRoot('clean')), 'not-a-repository');
  await mkdir(notARepository, { recursive: true });
});

afterAll(async () => {
  await set?.cleanup();
});

function fixtureRoot(name: string): string {
  const fixture = set.fixtures.find((candidate) => candidate.name === name);
  if (fixture === undefined) throw new Error(`the ${name} fixture is missing`);
  return fixture.root;
}

describe('where the quick commands live', () => {
  it('[I3] the file is the same one for both front-ends, wherever the machine keeps its config', () => {
    // One rule rather than two: the window and the CLI have to agree about which file "my commands"
    // means, and Electron's userData directory is not a place a person's dotfiles can reach.
    expect(presetPath({ XDG_CONFIG_HOME: '/tmp/config' })).toBe(
      '/tmp/config/orbitree/commands.json',
    );
    expect(presetPath({ HOME: '/home/someone' })).toBe(
      '/home/someone/.config/orbitree/commands.json',
    );
    // Windows has no `HOME`, and a rule that produced `/orbitree/commands.json` there would be a file
    // nobody could find.
    expect(presetPath({ USERPROFILE: 'C:\\Users\\someone' })).toContain('someone');
    // An empty XDG_CONFIG_HOME is unset, which is what the specification says and what a shell that
    // exported an empty variable means.
    expect(presetPath({ XDG_CONFIG_HOME: '', HOME: '/home/someone' })).toBe(
      '/home/someone/.config/orbitree/commands.json',
    );
  });
});

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
    await expect(openRepo(notARepository)).rejects.toBeInstanceOf(NotARepositoryError);
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

describe("the three diff questions, each against git's own numstat", () => {
  let root = '';

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'orbitree-diff-modes-'));
    const run = async (...args: string[]): Promise<void> => {
      const result = await git(root, ...args);
      if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    };
    const write = async (path: string, content: string): Promise<void> => {
      const full = join(root, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, 'utf8');
    };

    await run('init', '-b', 'main', '--quiet');
    await run('config', 'user.name', 'Diff Modes');
    await run('config', 'user.email', 'diff-modes@example.invalid');
    await run('config', 'commit.gpgsign', 'false');
    await run('config', 'core.autocrlf', 'false');

    // The base every comparison starts from.
    await write('same.txt', 'base for both\n');
    await write('staged.txt', 'base for staged\n');
    await write('unstaged.txt', 'base for unstaged\n');
    await run('add', '-A');
    await run('commit', '--quiet', '-m', 'base');

    // A file ready in the index and then edited again: both sides hold a different line.
    await write('same.txt', 'the index side\n');
    await run('add', 'same.txt');
    await write('same.txt', 'the worktree side\n');
    // Staged and untouched in the working tree.
    await write('staged.txt', 'the staged side\n');
    await run('add', 'staged.txt');
    // Untouched in the index, changed in the working tree.
    await write('unstaged.txt', 'the unstaged side\n');
    // New, and only in the index.
    await write('new-staged.txt', 'a brand new staged file\n');
    await run('add', 'new-staged.txt');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function counted(files: readonly DiffFile[]): Map<string, { added: number; deleted: number }> {
    return new Map(
      files.map((file) => [
        file.path,
        {
          added: file.hunks.reduce(
            (total, hunk) => total + hunk.lines.filter((line) => line.kind === 'add').length,
            0,
          ),
          deleted: file.hunks.reduce(
            (total, hunk) => total + hunk.lines.filter((line) => line.kind === 'del').length,
            0,
          ),
        },
      ]),
    );
  }

  it('[I5] readDiff asks three questions and git agrees on all three', async () => {
    const repo = await openRepo(root);
    const modes = [
      {
        name: 'the index against HEAD',
        request: { cached: true },
        gitArgs: ['diff', '--cached', 'HEAD', '--numstat', '-z', '-M'],
      },
      {
        name: 'the working tree against HEAD',
        request: { rev: 'HEAD' },
        gitArgs: ['diff', 'HEAD', '--numstat', '-z', '-M'],
      },
      {
        name: 'the working tree against the index',
        request: {},
        gitArgs: ['diff', '--numstat', '-z', '-M'],
      },
    ] as const;

    for (const mode of modes) {
      const files = await readDiff(repo, mode.request);
      const expected = parseNumstat((await git(root, ...mode.gitArgs)).stdout);
      expect(expected.size, mode.name).toBeGreaterThan(0);
      expect(counted(files), mode.name).toEqual(expected);
    }

    // The split is the point: the same file is one answer in the index and another in the
    // working tree, and the two questions never see each other's line.
    const index = await readDiff(repo, { cached: true });
    const worktree = await readDiff(repo, {});
    const indexSame = index.find((file) => file.path === 'same.txt');
    const worktreeSame = worktree.find((file) => file.path === 'same.txt');
    expect(indexSame?.raw).toContain('the index side');
    expect(indexSame?.raw).not.toContain('the worktree side');
    expect(worktreeSame?.raw).toContain('the worktree side');
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
    const notARepo = await run({ op: 'graph', limit: 1 }, { cwd: notARepository });
    expect(notARepo.exitCode).not.toBe(0);
    expect(notARepo.stderr.toLowerCase()).toContain('not a git repository');
  });

  it('a working directory that is not a directory is named, not faked as a missing git', async () => {
    // Spawning with a bad directory fails with the same errno as a missing binary, and the two
    // mean opposite things to a reader: one is "install git", the other is "that repository is
    // not there". A GUI needs the second to be its own value, so it has its own name.
    await expect(
      run({ op: 'status' }, { cwd: join(process.cwd(), 'package.json') }),
    ).rejects.toBeInstanceOf(PathNotFoundError);
  });
});
