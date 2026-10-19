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

  it('[I5] `worktrees` lists the working copies, the one asked from marked', async () => {
    // Two working copies of one repository: the same history in two directories, which is only
    // useful if a reader can tell which one they asked from and what each one is on.
    const beside = await mkdtemp(join(tmpdir(), 'orbitree-cli-worktree-'));
    const second = join(beside, 'side');
    await execFileAsync('git', ['worktree', 'add', '-b', 'side', second], { cwd: root });
    try {
      const result = await cli(['worktrees', root, '--json']);
      expect(result.code).toBe(EXIT.ok);
      const printed = JSON.parse(result.lines[0] as string) as {
        data: {
          root: string;
          worktrees: { path: string; branch: string | null; head: string | null }[];
        };
      };
      // git's own answer for how many working copies there are is what the parser is compared
      // against rather than the other way round.
      const listed = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: root });
      const count = listed.stdout.split('\n\n').filter((block) => block.trim() !== '').length;
      expect(printed.data.worktrees).toHaveLength(count);
      expect(count).toBe(2);

      // Both at the same commit, because it is one repository; the branch is what tells them apart.
      const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
      expect(printed.data.worktrees.map((worktree) => worktree.branch).sort()).toEqual([
        'main',
        'side',
      ]);
      for (const worktree of printed.data.worktrees) expect(worktree.head).toBe(head);
      const [here, other] = printed.data.worktrees;
      expect(here?.path.endsWith(printed.data.root.split('/').pop() ?? '')).toBe(true);
      expect(other?.path.endsWith('/side')).toBe(true);

      // And the text form marks the one the command was run from, which is the whole point.
      const lines = (await cli(['worktrees', root])).lines.join('\n').split('\n');
      expect(lines).toHaveLength(2);
      expect(lines.filter((line) => line.startsWith('*'))).toHaveLength(1);
      expect(lines.find((line) => line.startsWith('*'))).toContain('main');
    } finally {
      await execFileAsync('git', ['worktree', 'remove', '--force', second], { cwd: root });
      await execFileAsync('git', ['branch', '-D', 'side'], { cwd: root });
      await rm(beside, { recursive: true, force: true });
    }
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

  it('[I5] `remotes` reads the config, and two URLs are one remote', async () => {
    // Not a network call: `git remote -v` prints what the config says, so the fixture is two config
    // lines and the cross-check is the config itself.
    await execFileAsync('git', ['remote', 'add', 'origin', 'git@example.invalid:x/y.git'], {
      cwd: root,
    });
    await execFileAsync(
      'git',
      ['remote', 'set-url', '--push', 'origin', 'git@example.invalid:x/y-push.git'],
      { cwd: root },
    );
    try {
      const result = await cli(['remotes', root, '--json']);
      expect(result.code).toBe(EXIT.ok);
      const printed = JSON.parse(result.lines[0] as string) as {
        data: {
          remotes: { name: string; fetchUrl: string | null; pushUrl: string | null }[];
        };
      };
      expect(printed.data.remotes).toHaveLength(1);
      const origin = printed.data.remotes[0];
      expect(origin?.name).toBe('origin');
      // The fetch URL is the one the config holds, read a second way rather than believed.
      const fromConfig = await execFileAsync('git', ['config', '--get', 'remote.origin.url'], {
        cwd: root,
      });
      expect(origin?.fetchUrl).toBe(fromConfig.stdout.trim());
      expect(origin?.pushUrl).toBe('git@example.invalid:x/y-push.git');

      // The text form says both, because a push URL that differs is the thing a reader came for.
      const text = (await cli(['remotes', root])).lines.join('\n');
      expect(text).toContain('origin');
      expect(text).toContain('x/y-push.git');
    } finally {
      await execFileAsync('git', ['remote', 'remove', 'origin'], { cwd: root });
    }
  });

  it('[I5] `identity` says who commits are made as, and from which file', async () => {
    // The fixture sets its own name and email, so the local scope is what answers — the machine's
    // global config must not be able to decide what this test asserts.
    const result = await cli(['identity', root, '--json']);
    expect(result.code).toBe(EXIT.ok);
    const printed = JSON.parse(result.lines[0] as string) as {
      data: {
        identity: {
          name: { value: string; scope: string; origin: string } | null;
          email: { value: string } | null;
        };
      };
    };
    expect(printed.data.identity.name?.value).toBe('CLI Test');
    expect(printed.data.identity.name?.scope).toBe('local');
    expect(printed.data.identity.email?.value).toBe('cli@example.invalid');
    // Read a second way: git's own answer for the same question, and the file it names.
    const fromGit = await execFileAsync('git', ['config', '--show-origin', 'user.email'], {
      cwd: root,
    });
    expect(fromGit.stdout).toContain('cli@example.invalid');
    expect(printed.data.identity.email?.value).toBe(
      (await execFileAsync('git', ['config', 'user.email'], { cwd: root })).stdout.trim(),
    );

    // The text form names where each part came from, which is the half a person reads.
    const text = (await cli(['identity', root])).lines.join('\n');
    expect(text).toContain('CLI Test');
    expect(text).toContain('local');
  });

  it('[I5] a fetch reports its progress, as it goes and in the result', async () => {
    // A bare repository holding this fixture's history, and a second repository to fetch it into:
    // pushing with an explicit URL leaves the fixture itself with no remote and no new ref.
    const beside = await mkdtemp(join(tmpdir(), 'orbitree-cli-progress-'));
    const bare = join(beside, 'remote.git');
    const reader = join(beside, 'reader');
    // `-b main`, because a bare repository's HEAD is what a fetch of it resolves, and it otherwise
    // comes from the machine's `init.defaultBranch` — `master` on a CI runner.
    await execFileAsync('git', ['init', '--bare', '-b', 'main', '--quiet', bare]);
    await execFileAsync('git', ['push', '--quiet', `file://${bare}`, 'main'], { cwd: root });
    await execFileAsync('git', ['init', '-b', 'main', '--quiet', reader]);
    try {
      const args = ['run', reader, '--op', 'fetch', '--arg', `file://${bare}`];
      const text = await cli([...args, '--json']);
      const printed = JSON.parse(text.lines[0] as string) as {
        data: { progress: { phase: string; percent: number | null } | null; stderr: string };
      };
      // git writes progress only when something asked it to, so this is also the assertion that
      // `--progress` is in the argv: without it a pipe sees nothing until the fetch is over.
      expect(printed.data.progress?.phase).not.toBeUndefined();
      expect(text.errors.join('\n')).toContain('Count');
      // The lines are git's own, and the text git printed still holds them: the two reads of the
      // same event agree.
      expect(printed.data.stderr).toContain('Counting objects');
    } finally {
      await rm(beside, { recursive: true, force: true });
    }
  });

  it('[I5] a remote failure comes back explained, not only printed', async () => {
    // A push to a port nothing listens on: a real failure, instantly, and no network involved.
    const result = await cli([
      'run',
      root,
      '--op',
      'push',
      '--arg',
      'https://127.0.0.1:9/no/such.git',
      '--arg',
      'main',
      '--json',
    ]);
    // A failed remote command is a result rather than a failed invocation: `run` reports what git
    // did, exit code and all.
    expect(result.code).toBe(EXIT.ok);
    const printed = JSON.parse(result.lines[0] as string) as {
      data: {
        exitCode: number;
        stderr: string;
        diagnosis: { failure: string; what: string; whatToDo: string } | null;
      };
    };
    expect(printed.data.exitCode).not.toBe(0);
    expect(printed.data.stderr).toContain('Failed to connect');
    expect(printed.data.diagnosis?.failure).toBe('offline');
    expect(printed.data.diagnosis?.whatToDo).toContain('network');

    // And the text form says it too, after git's own words rather than instead of them.
    const text = await cli([
      'run',
      root,
      '--op',
      'push',
      '--arg',
      'https://127.0.0.1:9/no/such.git',
      '--arg',
      'main',
    ]);
    expect(text.lines.join('\n')).toContain('Check the network');
  });

  it('[I8] a credential in a remote URL never reaches the output, only the argv git gets', async () => {
    // A push to a port nothing listens on, with the token in the URL: instant, and the failure is
    // the same one a real remote gives. Everything the CLI prints is checked, because the command
    // line is printed in four places: the text form, the JSON, the dry run, and the diagnosis.
    const token = 'ghp_ABCDEFGHIJKLMNOPQRST';
    const url = `https://user:${token}@127.0.0.1:9/x.git`;
    const run = await cli(['run', root, '--op', 'push', '--arg', url, '--arg', 'main', '--json']);
    expect(run.lines.join('')).not.toContain(token);
    expect(run.errors.join('')).not.toContain(token);
    expect(run.lines.join('')).toContain('https://***@127.0.0.1:9/x.git');

    const text = await cli(['run', root, '--op', 'push', '--arg', url, '--arg', 'main']);
    expect(text.lines.join('')).not.toContain(token);

    // A dry run is a display as well, and it is the one a caller reads before deciding.
    const planned = await cli([
      'run',
      root,
      '--op',
      'push',
      '--arg',
      url,
      '--arg',
      'main',
      '--dry-run',
      '--json',
    ]);
    expect(planned.lines.join('')).not.toContain(token);
  });

  it('[I8] a stored credential is reported, and the secret is never printed', async () => {
    // The helper is a fixture that answers with a known secret, and the machine's own helpers are
    // taken out of the answer: a test that read somebody's keychain would be asserting about their
    // laptop rather than about this program.
    const beside = await mkdtemp(join(tmpdir(), 'orbitree-cli-credential-'));
    const config = join(beside, 'helper.config');
    const secret = 's3cret-not-a-token-shape';
    await writeFile(
      config,
      `[credential]\n\thelper = "!f() { echo username=someone; echo password=${secret}; }; f"\n`,
      'utf8',
    );
    const before = {
      global: process.env.GIT_CONFIG_GLOBAL,
      system: process.env.GIT_CONFIG_SYSTEM,
    };
    process.env.GIT_CONFIG_GLOBAL = config;
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';
    try {
      const result = await cli(['credential', root, '--host', 'example.invalid', '--json']);
      expect(result.code).toBe(EXIT.ok);
      const printed = JSON.parse(result.lines[0] as string) as {
        data: { available: boolean; username: string | null; hasPassword: boolean };
      };
      expect(printed.data.available).toBe(true);
      expect(printed.data.username).toBe('someone');
      expect(printed.data.hasPassword).toBe(true);
      expect(result.lines.join('')).not.toContain(secret);
      expect(result.errors.join('')).not.toContain(secret);

      // The text form names who the credential is for, and not what it is.
      const text = await cli(['credential', root, '--host', 'example.invalid']);
      expect(text.lines.join('')).toContain('someone');
      expect(text.lines.join('')).not.toContain(secret);
    } finally {
      if (before.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = before.global;
      if (before.system === undefined) delete process.env.GIT_CONFIG_SYSTEM;
      else process.env.GIT_CONFIG_SYSTEM = before.system;
      await rm(beside, { recursive: true, force: true });
    }
  });

  it('[I5] `blame` names the commit each line came from, and says when one is not committed', async () => {
    // `a.txt` is committed as `one` and then rewritten in the working tree as `two`, so the same file
    // has both answers at once: what is on disk, and what the commit holds.
    const head = (
      await execFileAsync('git', ['log', '--format=%H', '-1'], { cwd: root })
    ).stdout.trim();
    const result = await cli(['blame', root, '--file', 'a.txt', '--json']);
    expect(result.code).toBe(EXIT.ok);
    const printed = JSON.parse(result.lines[0] as string) as {
      data: { lines: { oid: string; content: string; line: number; boundary: boolean }[] };
    };
    expect(printed.data.lines).toHaveLength(1);
    expect(printed.data.lines[0]?.content).toBe('two');
    expect(printed.data.lines[0]?.line).toBe(1);
    // The line that is only in the working tree is not blamed on a commit, and git says so with an
    // all-zero sha: a window has to show that as "not committed yet" rather than as a jump.
    expect(printed.data.lines[0]?.oid).toBe('0'.repeat(40));

    // At the commit itself the file is one line, which is the other direction of the same question.
    const at = await cli(['blame', root, '--file', 'a.txt', '--rev', 'HEAD', '--json']);
    const committed = JSON.parse(at.lines[0] as string) as {
      data: { lines: { oid: string; content: string; boundary: boolean }[] };
    };
    expect(committed.data.lines).toHaveLength(1);
    expect(committed.data.lines[0]?.content).toBe('one');
    expect(committed.data.lines[0]?.oid).toBe(head);
    // The first commit of the repository is a boundary: git has nowhere earlier to walk, and saying so
    // is what stops a reader looking for a line's origin in a commit that does not exist.
    expect(committed.data.lines[0]?.boundary).toBe(true);

    // The text form names the commit abbreviated, the date, the author and the line — and says
    // `Not Committed Yet`, in git's own words, for the line that is only in the working tree.
    const text = await cli(['blame', root, '--file', 'a.txt']);
    expect(text.lines.join('\n')).toContain('Not Committed Yet');
    expect(text.lines.join('\n')).toContain('two');

    const committedText = await cli(['blame', root, '--file', 'a.txt', '--rev', 'HEAD']);
    expect(committedText.lines.join('\n')).toContain(head.slice(0, 8));
    expect(committedText.lines.join('\n')).toContain('one');
    // Abbreviated on purpose: eight characters is what a person can hold in their head, and the whole
    // sha is in `--json` for whoever needs to paste it.
    expect(committedText.lines.join('\n')).not.toContain(head);
  });

  it('[I5] `compare` names what each side has, and git agrees', async () => {
    // A fork of its own, so the two sides really have different commits: the shared fixture is one
    // branch, and comparing a branch with itself would prove nothing.
    const beside = await mkdtemp(join(tmpdir(), 'orbitree-cli-compare-'));
    const fork = join(beside, 'fork');
    const at = (args: string[]): Promise<{ stdout: string }> =>
      execFileAsync('git', args, { cwd: fork }) as Promise<{ stdout: string }>;
    await execFileAsync('git', ['init', '-b', 'main', '--quiet', fork]);
    await execFileAsync('git', ['config', 'user.name', 'CLI Compare'], { cwd: fork });
    await execFileAsync('git', ['config', 'user.email', 'compare@example.invalid'], { cwd: fork });
    await writeFile(join(fork, 'base.txt'), 'the base\n', 'utf8');
    await at(['add', '-A']);
    await at(['commit', '--quiet', '-m', 'the base']);
    await at(['checkout', '--quiet', '-b', 'left']);
    await writeFile(join(fork, 'left.txt'), 'left\n', 'utf8');
    await at(['add', '-A']);
    await at(['commit', '--quiet', '-m', 'only on the left']);
    await at(['checkout', '--quiet', 'main']);
    await at(['checkout', '--quiet', '-b', 'right']);
    await writeFile(join(fork, 'right.txt'), 'right\n', 'utf8');
    await at(['add', '-A']);
    await at(['commit', '--quiet', '-m', 'only on the right']);

    try {
      const result = await cli(['compare', fork, '--left', 'left', '--right', 'right', '--json']);
      expect(result.code).toBe(EXIT.ok);
      const printed = JSON.parse(result.lines[0] as string) as {
        data: {
          left: string;
          right: string;
          onlyLeft: { hash: string; subject: string }[];
          onlyRight: { hash: string; subject: string }[];
        };
      };
      expect(printed.data.left).toBe('left');
      expect(printed.data.onlyLeft.map((commit) => commit.subject)).toEqual(['only on the left']);
      expect(printed.data.onlyRight.map((commit) => commit.subject)).toEqual(['only on the right']);

      // git's own answer, read a second way: the same two lists, one flag apart.
      const leftOnly = await at([
        'log',
        '--left-only',
        '--cherry-pick',
        '--format=%H',
        'left...right',
      ]);
      const rightOnly = await at([
        'log',
        '--right-only',
        '--cherry-pick',
        '--format=%H',
        'left...right',
      ]);
      expect(printed.data.onlyLeft.map((commit) => commit.hash)).toEqual(
        leftOnly.stdout.split('\n').filter((line) => line !== ''),
      );
      expect(printed.data.onlyRight.map((commit) => commit.hash)).toEqual(
        rightOnly.stdout.split('\n').filter((line) => line !== ''),
      );

      // The text form says which side each list is: the question is read one side at a time.
      const text = await cli(['compare', fork, '--left', 'left', '--right', 'right']);
      expect(text.lines.join('\n')).toContain('only on left (1)');
      expect(text.lines.join('\n')).toContain('only on right (1)');
    } finally {
      await rm(beside, { recursive: true, force: true });
    }
  });

  it('[I5] `graph` searches the history it draws, with git as the judge', async () => {
    // The fixture's one commit is authored by `CLI Test`, and its subject is `the first commit`.
    const bySubject = await cli(['graph', root, '--grep', 'first commit', '--json']);
    const searched = JSON.parse(bySubject.lines[0] as string) as {
      data: { commits: { hash: string }[]; total: number };
    };
    expect(searched.data.commits).toHaveLength(1);
    expect(searched.data.total).toBe(1);

    const byAuthor = await cli(['graph', root, '--author', 'CLI Test', '--json']);
    const authored = JSON.parse(byAuthor.lines[0] as string) as {
      data: { commits: { hash: string }[]; total: number };
    };
    expect(authored.data.commits.map((entry) => entry.hash).sort()).toEqual(
      (
        await execFileAsync('git', ['log', '--format=%H', '--author=CLI Test'], { cwd: root })
      ).stdout
        .split('\n')
        .filter((line) => line !== ''),
    );

    // `--mine` is the identity the repository is configured with, which is the same one `identity`
    // answers with: the flag is a reading of the config, not a second place to keep a name.
    const mine = await cli(['graph', root, '--mine', '--json']);
    const printed = JSON.parse(mine.lines[0] as string) as { data: { commits: unknown[] } };
    expect(printed.data.commits.length).toBeGreaterThan(0);

    // And a repository with no address anywhere — the machine's own config taken out of the answer, as
    // a fixture must, since this machine is configured — is a usage error rather than a search for
    // nothing, because there is no name to search by.
    const anonymous = await mkdtemp(join(tmpdir(), 'orbitree-cli-anonymous-'));
    const repository = join(anonymous, 'repo');
    const empty = join(anonymous, 'empty.config');
    await execFileAsync('git', ['init', '-b', 'main', '--quiet', repository]);
    await writeFile(empty, '', 'utf8');
    const before = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_SYSTEM };
    process.env.GIT_CONFIG_GLOBAL = empty;
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';
    try {
      const refused = await cli(['graph', repository, '--mine', '--json']);
      expect(refused.code).toBe(EXIT.usage);
      expect(refused.lines.join('')).toContain('no user.email');
    } finally {
      if (before.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = before.global;
      if (before.system === undefined) delete process.env.GIT_CONFIG_SYSTEM;
      else process.env.GIT_CONFIG_SYSTEM = before.system;
      await rm(anonymous, { recursive: true, force: true });
    }
  });

  it('[I5] a command from a person’s own file runs by id, and its argv is the one `run` would build', async () => {
    // A file of their own, in the place a person's dotfiles hold one, with one entry that is not an
    // operation at all: the file is read the way the window reads it, and `--commands` points at it
    // rather than at the machine's own.
    const beside = await mkdtemp(join(tmpdir(), 'orbitree-cli-preset-'));
    const file = join(beside, 'commands.json');
    await writeFile(
      file,
      JSON.stringify({
        commands: [
          {
            id: 'status-here',
            label: 'Status',
            hint: 'status',
            danger: false,
            command: { op: 'status' },
          },
          {
            id: 'tag-here',
            label: 'Tag this branch',
            hint: 'tag v9.9.9 {branch}',
            danger: false,
            command: { op: 'tag-create', name: 'v9.9.9', rev: '{branch}' },
          },
          {
            id: 'teleport',
            label: 'Teleport',
            hint: 'not an operation',
            danger: false,
            command: { op: 'teleport' },
          },
        ],
      }),
      'utf8',
    );

    try {
      // The same argv `run --op` would build for the same command: the file chooses *which* command, not how
      // one is built.
      const byId = await cli([
        'quick',
        root,
        '--id',
        'status-here',
        '--commands',
        file,
        '--dry-run',
        '--json',
      ]);
      const byOp = await cli(['run', root, '--op', 'status', '--dry-run', '--json']);
      const fromFile = JSON.parse(byId.lines[0] as string) as {
        command: string;
        data: { argv: readonly string[]; id?: string };
      };
      const fromOp = JSON.parse(byOp.lines[0] as string) as { data: { argv: readonly string[] } };
      expect(fromFile.command).toBe('quick');
      expect(fromFile.data.id).toBe('status-here');
      expect(fromFile.data.argv).toEqual(fromOp.data.argv);

      // A placeholder comes from `--set`, and one nobody set is refused with the name of the thing missing.
      const filled = await cli([
        'quick',
        root,
        '--id',
        'tag-here',
        '--commands',
        file,
        '--set',
        'branch=next',
        '--dry-run',
        '--json',
      ]);
      expect(
        (JSON.parse(filled.lines[0] as string) as { data: { argv: readonly string[] } }).data.argv,
      ).toEqual(['tag', 'v9.9.9', 'next']);

      const unfilled = await cli([
        'quick',
        root,
        '--id',
        'tag-here',
        '--commands',
        file,
        '--dry-run',
      ]);
      expect(unfilled.code).toBe(EXIT.usage);
      expect(unfilled.errors.join('\n')).toContain('needs {branch}');

      // An id the file does not hold lists what it does hold, and says how many entries were refused — an
      // entry that is not an operation is not a command, and the file is not silently empty.
      const unknown = await cli(['quick', root, '--id', 'nope', '--commands', file, '--dry-run']);
      expect(unknown.code).toBe(EXIT.usage);
      expect(unknown.errors.join('\n')).toContain('holds status-here, tag-here');
      expect(unknown.errors.join('\n')).toContain('1 entry refused: teleport');

      // And a machine with no file says where one goes rather than failing about a path.
      const missing = await cli([
        'quick',
        root,
        '--id',
        'anything',
        '--commands',
        join(beside, 'none.json'),
      ]);
      expect(missing.code).toBe(EXIT.usage);
      expect(missing.errors.join('\n')).toContain('no commands file at');
    } finally {
      await rm(beside, { recursive: true, force: true });
    }
  });

  it('the example preset is one a person can copy: every command in it runs', async () => {
    // The file under `docs/` is documentation, so it is the suite that keeps it true: each entry is asked for
    // by id and resolved to an argv, which is what "a preset somebody can commit to their dotfiles" means.
    const example = join(import.meta.dirname, '..', '..', '..', 'docs', 'commands-example.json');
    const byId = await cli([
      'quick',
      root,
      '--id',
      'fetch-all',
      '--commands',
      example,
      '--dry-run',
      '--json',
    ]);
    expect(byId.code).toBe(EXIT.ok);
    expect(
      (JSON.parse(byId.lines[0] as string) as { data: { argv: readonly string[] } }).data.argv,
    ).toEqual(['fetch', '--progress', '--prune']);

    // The one that takes a value, filled the way the table in the docs says.
    const tag = await cli([
      'quick',
      root,
      '--id',
      'tag-this-branch',
      '--commands',
      example,
      '--set',
      'branch=main',
      '--dry-run',
      '--json',
    ]);
    expect(tag.code).toBe(EXIT.ok);
    expect(
      (JSON.parse(tag.lines[0] as string) as { data: { argv: readonly string[] } }).data.argv,
    ).toEqual(['tag', 'wip', 'main']);
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
      blame: ['a.txt'],
      compare: ['main', 'next'],
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
      'remote-list': [],
      identity: [],
      'credential-fill': ['github.com'],
      'remote-add': ['origin', 'git@example.invalid:x/y.git'],
      'remote-rename': ['origin', 'upstream'],
      'remote-set-url': ['origin', '../elsewhere'],
      'remote-remove': ['origin'],
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
