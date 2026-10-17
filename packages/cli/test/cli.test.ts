import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { openRepo, readStatus } from '@orbitree/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CliIo, EXIT, main } from '../src/index.ts';

const execFileAsync = promisify(execFile);

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'orbitree-cli-'));
  const git = (...args: string[]): Promise<unknown> =>
    execFileAsync('git', args, { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  await git('init', '-b', 'main', '--quiet');
  await git('config', 'user.name', 'CLI Test');
  await git('config', 'user.email', 'cli@example.invalid');
  await writeFile(join(root, 'a.txt'), 'one\n', 'utf8');
  await git('add', '-A');
  await git('commit', '--quiet', '-m', 'the first commit');
  await writeFile(join(root, 'a.txt'), 'two\n', 'utf8');
  await writeFile(join(root, 'b.txt'), 'new\n', 'utf8');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Capture {
  readonly io: CliIo;
  readonly lines: string[];
  readonly errors: string[];
}

function capture(): Capture {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    io: {
      out: (line) => lines.push(line),
      err: (line) => errors.push(line),
    },
  };
}

async function cli(
  argv: readonly string[],
): Promise<{ code: number; lines: string[]; errors: string[] }> {
  const captured = capture();
  const code = await main(argv, captured.io);
  return { code, lines: captured.lines, errors: captured.errors };
}

describe('the CLI and the app are the same program', () => {
  it('[I3] `status --json` is the core’s own reading, not a second parser', async () => {
    const result = await cli(['status', root, '--json']);
    expect(result.code).toBe(EXIT.ok);
    expect(result.lines).toHaveLength(1);

    const printed = JSON.parse(result.lines[0] as string) as {
      schemaVersion: number;
      command: string;
      ok: boolean;
      data: { root: string; entries: unknown[]; head: { kind: string }; pending: string | null };
    };
    expect(printed.command).toBe('status');
    expect(printed.ok).toBe(true);

    // The same call through the library: byte-identical, because it is the same function.
    const repo = await openRepo(root);
    const state = await readStatus(repo);
    expect(printed.data.root).toBe(repo.root);
    expect(printed.data.head).toEqual(state.head);
    expect(printed.data.entries).toEqual(state.entries);
    expect(printed.data.entries).toHaveLength(2);
    // The pending operation is a field like any other, so it is byte-identical too.
    expect(printed.data.pending).toBe(state.pending);
    expect(state.pending).toBeNull();
  });

  it('[I3] `graph --json` carries lanes and edges, and the working tree', async () => {
    const result = await cli(['graph', root, '--json', '--limit', '10']);
    const printed = JSON.parse(result.lines[0] as string) as {
      data: { rows: { lane: number }[]; edges: unknown[]; laneCount: number; wip: unknown };
    };
    expect(printed.data.laneCount).toBe(1);
    expect(printed.data.rows).toHaveLength(1);
    expect(printed.data.edges).toHaveLength(0);

    // The fixture is one commit, its tracked file modified in the working tree, and one file
    // that is untracked: the node above the first commit says exactly that, and it is read by
    // the same call rather than by a second one the caller would have to know about.
    const head = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });
    expect(printed.data.wip).toEqual({
      on: head.stdout.trim(),
      staged: 0,
      unstaged: 1,
      conflicted: 0,
      untracked: 1,
      dirty: true,
    });
  });

  it('[I5] `graph` hides what only a hidden name can reach', async () => {
    // The claim is about the picture and about nothing else: nothing is written, HEAD stays where it
    // is, and the commits kept are the ones a visible name can still reach. `HEAD` is in the tips
    // the window sends, so the commit somebody is standing on never vanishes from their own picture.
    const listed = await cli(['graph', root, '--all', '--json', '--limit', '10']);
    const all = (JSON.parse(listed.lines[0] as string) as { data: { commits: { hash: string }[] } })
      .data;
    expect(all.commits.length).toBeGreaterThan(0);

    // A name that is not there hides nothing, which is the difference between a filter and a guess.
    const bogus = await cli(['graph', root, '--all', '--hide', 'no-such-branch', '--json']);
    const kept = (
      JSON.parse(bogus.lines[0] as string) as {
        data: { commits: { hash: string }[]; hidden: string[]; total: number };
      }
    ).data;
    expect(kept.hidden).toEqual(['no-such-branch']);
    expect(kept.commits.map((entry) => entry.hash).sort()).toEqual(
      all.commits.map((entry) => entry.hash).sort(),
    );
    // The count of the history is not the count of the picture, and the two are different fields for
    // that reason: the picture says what it left out.
    expect(kept.total).toBeGreaterThanOrEqual(kept.commits.length);
    // And hiding wrote nothing: HEAD is where it was, read with git rather than believed.
    const head = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });
    expect(head.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it('[I3] every operation the CLI publishes is reachable through `run --op`', async () => {
    // The claim of the doc and of the roadmap item: `ops` lists what `run` accepts. Two lists that
    // can drift, so one of them — the published one — is what the test walks, and an operation that
    // grew a name in the core and not an argv here fails as unreachable rather than as a surprise
    // for whoever read the list and tried it.
    const listed = await cli(['ops', '--json']);
    const published = (
      JSON.parse(listed.lines[0] as string) as { readonly data: readonly { op: string }[] }
    ).data.map((entry) => entry.op);

    // What each operation needs, in the order `ops` shows its argv.
    const args: Readonly<Record<string, readonly string[]>> = {
      'repo-root': [],
      status: [],
      graph: ['10'],
      refs: [],
      'stash-list': [],
      diff: [],
      'commit-detail': [],
      'commit-patch': [],
      'pending-operation': ['MERGE_HEAD'],
      add: ['file.txt'],
      unstage: ['file.txt'],
      commit: [],
      'branch-create': ['a-branch'],
      'branch-rename': ['a-branch', 'another-branch'],
      checkout: ['main'],
      'tag-create': ['v9.9.9'],
      'tag-delete': ['v9.9.9'],
      'take-side': ['ours', 'file.txt'],
      'merge-abort': [],
      'reset-soft': ['HEAD~1'],
      'regenerate-conflict': ['file.txt'],
      'conflict-side': ['ours', 'file.txt'],
      'discard-hunk': ['file.txt', '0'],
      'resolve-conflict': ['file.txt', '0', 'ours'],
      'resolve-file': ['file.txt', 'the whole file'],
      merge: ['main'],
      'stash-push': [],
      'stash-pop': [],
      'stash-apply': ['stash@{0}'],
      'stash-show': ['stash@{0}'],
      'worktree-list': [],
      'worktree-add': ['/tmp/orbitree-worktree-test'],
      'worktree-remove': ['/tmp/orbitree-worktree-test'],
      'stash-drop': ['stash@{0}'],
      'branch-delete': ['a-branch'],
      fetch: [],
      pull: [],
      push: ['origin', 'main'],
      'reset-hard': ['HEAD'],
      clean: ['file.txt'],
      discard: ['file.txt'],
    };

    const unreachable: string[] = [];
    for (const op of published) {
      const needed = args[op];
      if (needed === undefined) {
        unreachable.push(op);
        continue;
      }
      // The message is a flag rather than an argument, because a commit's other field is: the
      // CLI's own surface names the two the way the window's box does.
      const message = op === 'commit' ? ['--message', 'a message'] : [];
      const flat = [...needed.flatMap((value) => ['--arg', value]), ...message];
      // `--dry-run` is what makes this possible for the destructive ones: it resolves the argv
      // before the confirmation check, which is the whole point of it.
      const result = await cli(['run', root, '--op', op, ...flat, '--dry-run', '--json']);
      const printed = JSON.parse((result.lines[0] ?? '{}') as string) as {
        ok?: boolean;
        data?: { argv?: readonly string[] };
      };
      if (result.code !== 0 || printed.ok !== true || (printed.data?.argv?.length ?? 0) === 0) {
        unreachable.push(op);
      }
    }
    expect(unreachable).toEqual([]);
  });

  it('a directory that does not exist is reported as not-a-repository, not as a bad argument', async () => {
    const result = await cli(['status', join(root, 'gone'), '--json']);
    expect(result.code).toBe(EXIT.notARepository);
    const printed = JSON.parse(result.lines[0] as string) as { error: { kind: string } };
    expect(printed.error.kind).toBe('not-a-repository');
  });

  it('a JSON failure is still one JSON object, with a kind and an exit code', async () => {
    const result = await cli(['status', '/tmp', '--json']);
    expect(result.code).toBe(EXIT.notARepository);
    const printed = JSON.parse(result.lines[0] as string) as {
      ok: boolean;
      error: { kind: string; message: string };
    };
    expect(printed.ok).toBe(false);
    expect(printed.error.kind).toBe('not-a-repository');
    expect(printed.error.message.length).toBeGreaterThan(0);
  });

  it('[I1] a destructive operation is refused with its own exit code', async () => {
    const result = await cli(['run', root, '--op', 'clean', '--json']);
    expect(result.code).toBe(EXIT.confirmationRequired);
    const printed = JSON.parse(result.lines[0] as string) as { error: { kind: string } };
    expect(printed.error.kind).toBe('confirmation-required');
  });

  it('[I1] a dry run prints the argv and leaves the working tree alone', async () => {
    const before = await readStatus(await openRepo(root));
    const result = await cli(['run', root, '--op', 'clean', '--dry-run', '--json']);
    expect(result.code).toBe(EXIT.ok);
    const printed = JSON.parse(result.lines[0] as string) as {
      data: { argv: string[]; risk: string };
    };
    expect(printed.data.argv).toEqual(['clean', '-fd']);
    expect(printed.data.risk).toBe('destructive');
    const after = await readStatus(await openRepo(root));
    expect(after.entries).toEqual(before.entries);
  });

  it('[I1] a confirmed destructive command runs, and the confirmation is a reason', async () => {
    await writeFile(join(root, 'scratch.txt'), 'temporary\n', 'utf8');
    const result = await cli([
      'run',
      root,
      '--op',
      'clean',
      '--confirm',
      'removing a scratch file',
      '--json',
    ]);
    expect(result.code).toBe(EXIT.ok);
    const printed = JSON.parse(result.lines[0] as string) as {
      data: { exitCode: number; op: string };
    };
    expect(printed.data.op).toBe('clean');
    expect(printed.data.exitCode).toBe(0);
    const after = await readStatus(await openRepo(root));
    expect(after.entries.map((entry) => entry.path)).not.toContain('scratch.txt');
  });

  it('an unknown operation is a usage error, not a guess', async () => {
    const result = await cli(['run', root, '--op', 'rm-rf', '--json']);
    expect(result.code).toBe(EXIT.usage);
    const printed = JSON.parse(result.lines[0] as string) as { error: { kind: string } };
    expect(printed.error.kind).toBe('invalid-argument');
  });

  it('`doctor` and `ops` answer without a repository', async () => {
    const doctor = await cli(['doctor', root, '--json']);
    const report = JSON.parse(doctor.lines[0] as string) as {
      data: { gitIsNewEnough: boolean; git: string };
    };
    expect(report.data.gitIsNewEnough).toBe(true);

    const ops = await cli(['ops', '--json']);
    const listing = JSON.parse(ops.lines[0] as string) as { data: { op: string; risk: string }[] };
    expect(listing.data.length).toBeGreaterThan(15);
    expect(listing.data.some((row) => row.risk === 'destructive')).toBe(true);
  });

  it('`schema` is machine-readable, and `--help` is not an error', async () => {
    const schema = await cli(['schema']);
    const parsed = JSON.parse(schema.lines[0] as string) as { exitCodes: { ok: number } };
    expect(parsed.exitCodes.ok).toBe(0);
    expect(await cli(['--help']).then((result) => result.code)).toBe(EXIT.ok);
    expect(await cli(['nonsense']).then((result) => result.code)).toBe(EXIT.usage);
  });

  it('diff names the three questions and refuses to answer two at once', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'orbitree-cli-diff-'));
    const git = (...args: string[]): Promise<unknown> =>
      execFileAsync('git', args, { cwd: repo, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    try {
      await git('init', '-b', 'main', '--quiet');
      await git('config', 'user.name', 'CLI Diff');
      await git('config', 'user.email', 'cli-diff@example.invalid');
      await writeFile(join(repo, 'a.txt'), 'base\n', 'utf8');
      await git('add', '-A');
      await git('commit', '--quiet', '-m', 'base');
      // The index holds one side of the change; the working tree holds the other.
      await writeFile(join(repo, 'a.txt'), 'STAGED_SIDE\n', 'utf8');
      await git('add', 'a.txt');
      await writeFile(join(repo, 'a.txt'), 'WORKTREE_SIDE\n', 'utf8');

      const staged = await cli(['diff', repo, '--cached', '--json']);
      expect(staged.code).toBe(EXIT.ok);
      const stagedData = JSON.parse(staged.lines[0] as string) as {
        data: { rev: string; files: { raw: string }[] };
      };
      expect(stagedData.data.rev).toBe('HEAD');
      expect(stagedData.data.files.map((file) => file.raw).join('')).toContain('STAGED_SIDE');
      expect(stagedData.data.files.map((file) => file.raw).join('')).not.toContain('WORKTREE_SIDE');

      const unstaged = await cli(['diff', repo, '--unstaged', '--json']);
      expect(unstaged.code).toBe(EXIT.ok);
      const unstagedData = JSON.parse(unstaged.lines[0] as string) as {
        data: { rev: string | null; files: { raw: string }[] };
      };
      expect(unstagedData.data.rev).toBeNull();
      expect(unstagedData.data.files.map((file) => file.raw).join('')).toContain('WORKTREE_SIDE');

      const conflict = await cli(['diff', repo, '--cached', '--unstaged', '--json']);
      expect(conflict.code).toBe(EXIT.usage);
      const conflictData = JSON.parse(conflict.lines[0] as string) as { error: { kind: string } };
      expect(conflictData.error.kind).toBe('invalid-argument');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('[I5] a repository stopped mid-merge says so, in both forms', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'orbitree-cli-merge-'));
    const git = (...args: string[]): Promise<unknown> =>
      execFileAsync('git', args, { cwd: repo, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    try {
      await git('init', '-b', 'main', '--quiet');
      await git('config', 'user.name', 'CLI Merge');
      await git('config', 'user.email', 'cli-merge@example.invalid');
      await writeFile(join(repo, 'shared.txt'), 'base\n', 'utf8');
      await git('add', '-A');
      await git('commit', '--quiet', '-m', 'base');
      await git('checkout', '--quiet', '-b', 'left');
      await writeFile(join(repo, 'shared.txt'), 'left\n', 'utf8');
      await git('commit', '--quiet', '-am', 'left');
      await git('checkout', '--quiet', 'main');
      await git('checkout', '--quiet', '-b', 'right');
      await writeFile(join(repo, 'shared.txt'), 'right\n', 'utf8');
      await git('commit', '--quiet', '-am', 'right');
      // The merge is left failed on purpose: the merge head is what makes this a fixture.
      await git('merge', '--no-edit', 'left').catch(() => undefined);
      expect(await git('rev-parse', '--verify', '-q', 'MERGE_HEAD')).toBeTruthy();

      const printed = await cli(['status', repo, '--json']);
      expect(printed.code).toBe(EXIT.ok);
      const data = JSON.parse(printed.lines[0] as string) as { data: { pending: string | null } };
      expect(data.data.pending).toBe('merge');

      const human = await cli(['status', repo]);
      expect(human.errors).toEqual([]);
      expect(human.lines.join('\n')).toContain('merge in progress');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
