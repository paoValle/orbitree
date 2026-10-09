/**
 * Test support: builds real git repositories, with the real `git` binary.
 *
 * The fixtures do not use the product's own executor on purpose. If they did, a bug in
 * argument building would produce a repository that matches the buggy expectation, and
 * the test would pass while the product was wrong.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface GitOut {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/** Runs git in `cwd`. A non-zero exit is returned, not thrown: conflicts are fixtures too. */
export async function git(cwd: string, ...args: string[]): Promise<GitOut> {
  try {
    const { stdout, stderr } = await run('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_DATE: '2026-01-01T00:00:00+00:00',
        GIT_COMMITTER_DATE: '2026-01-01T00:00:00+00:00',
        LC_ALL: 'C',
      },
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', code: failure.code ?? 1 };
  }
}

export interface Fixture {
  readonly name: string;
  readonly root: string;
}

export interface FixtureSet {
  readonly fixtures: readonly Fixture[];
  readonly cleanup: () => Promise<void>;
  readonly gitVersion: string;
}

export async function makeFixtures(): Promise<FixtureSet> {
  const base = await mkdtemp(join(tmpdir(), 'keplerk-fixtures-'));
  const fixtures: Fixture[] = [];

  const create = async (name: string): Promise<string> => {
    const root = join(base, name);
    await mkdir(root, { recursive: true });
    await git(root, 'init', '-b', 'main', '--quiet');
    await git(root, 'config', 'user.name', 'Fixture Author');
    await git(root, 'config', 'user.email', 'fixture@example.invalid');
    await git(root, 'config', 'commit.gpgsign', 'false');
    await git(root, 'config', 'core.autocrlf', 'false');
    fixtures.push({ name, root });
    return root;
  };

  const write = async (root: string, path: string, content: string): Promise<void> => {
    const full = join(root, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content, 'utf8');
  };

  const commit = async (root: string, message: string): Promise<void> => {
    await git(root, 'add', '-A');
    const result = await git(root, 'commit', '--quiet', '-m', message);
    if (result.code !== 0) throw new Error(`fixture commit failed: ${result.stderr}`);
  };

  // --- 1. a repository with no commits at all ---
  await create('unborn');

  // --- 2. one commit, clean tree ---
  const clean = await create('clean');
  await write(clean, 'README.md', '# fixture\n');
  await commit(clean, 'the first commit');

  // --- 3. every ordinary state at once, plus a staged rename ---
  const mixed = await create('mixed');
  await write(mixed, 'tracked.txt', 'one\n');
  await write(mixed, 'old-name.txt', 'to be renamed\n');
  await write(mixed, 'gone.txt', 'delete me\n');
  await commit(mixed, 'three files');
  await write(mixed, 'tracked.txt', 'one changed\n');
  await write(mixed, 'staged.txt', 'new and staged\n');
  await write(mixed, 'untracked.txt', 'new and untracked\n');
  await git(mixed, 'add', 'staged.txt');
  await git(mixed, 'mv', 'old-name.txt', 'new-name.txt');
  await git(mixed, 'rm', '--quiet', 'gone.txt');
  await write(mixed, 'tracked.txt', 'one changed again\n');

  // --- 4. a merge conflict left in place ---
  const conflicted = await create('conflicted');
  await write(conflicted, 'shared.txt', 'base\n');
  await commit(conflicted, 'base');
  await git(conflicted, 'checkout', '--quiet', '-b', 'left');
  await write(conflicted, 'shared.txt', 'left\n');
  await commit(conflicted, 'left');
  await git(conflicted, 'checkout', '--quiet', 'main');
  await git(conflicted, 'checkout', '--quiet', '-b', 'right');
  await write(conflicted, 'shared.txt', 'right\n');
  await commit(conflicted, 'right');
  await git(conflicted, 'merge', '--no-edit', 'left');

  // --- 5. a history with real merges, for the graph ---
  const history = await create('history');
  await write(history, 'a.txt', 'a\n');
  await commit(history, 'root');
  await git(history, 'checkout', '--quiet', '-b', 'feature-a');
  await write(history, 'a.txt', 'a from feature-a\n');
  // A real message body, so the detail parser is checked against `%B` and not only `%s`.
  await commit(history, 'work on feature-a\n\nthis body spans\nmore than one line');
  await git(history, 'checkout', '--quiet', 'main');
  await git(history, 'checkout', '--quiet', '-b', 'feature-b');
  await write(history, 'b.txt', 'b\n');
  await commit(history, 'work on feature-b');
  await git(history, 'checkout', '--quiet', 'main');
  await write(history, 'main.txt', 'm\n');
  await commit(history, 'work on main');
  await git(history, 'merge', '--no-edit', 'feature-a');
  await git(history, 'merge', '--no-edit', 'feature-b');
  await git(history, 'tag', 'v1');
  await git(history, 'branch', 'unmerged-feature', 'feature-a');
  // HEAD is detached at the first parent of the tagged merge, which is itself a merge; the
  // root stays reachable through `git rev-list --max-parents=0 HEAD` from there.
  await git(history, 'checkout', '--quiet', '--detach', 'HEAD~1');

  // --- 6. filenames that are genuinely hostile to shell-less argument passing ---
  const nasty = await create('nasty');
  await write(nasty, 'with space.txt', 'space\n');
  await write(nasty, 'caffè-ünicode.txt', 'unicode\n');
  await write(nasty, '-leading-dash.txt', 'dash\n');
  await write(nasty, 'quote"and\'apostrophe.txt', 'quotes\n');
  await write(nasty, '$(touch pwned).txt', 'substitution\n');
  await commit(nasty, 'hostile names');
  await write(nasty, 'with space.txt', 'space changed\n');

  // --- 7. one repository whose diff against HEAD exercises every shape the parser sees ---
  const diffable = await create('diffable');
  await write(diffable, 'context.txt', 'alpha\nbravo\ncharlie\ndelta\necho\n');
  await write(
    diffable,
    'rename-me.txt',
    'line one\nline two\nline three\nline four\nline five\nline six\nline seven\nline eight\n',
  );
  await write(diffable, 'delete-me.txt', 'delete me\n');
  await write(diffable, 'no-newline.txt', 'trailing text\n');
  // A non-ASCII name forces git to quote the `---`/`+++` paths, so the parser's unquoting
  // is checked against `--name-only -z`, which is never quoted.
  await write(diffable, 'caff\u00e8-\u00fcnicode.txt', 'before\n');
  await commit(diffable, 'the diffable base');
  await write(diffable, 'caff\u00e8-\u00fcnicode.txt', 'after\n');
  await write(diffable, 'context.txt', 'alpha\nbravo\nCHARLIE\ndelta\necho\n');
  await write(diffable, 'added.txt', 'brand new\n');
  await git(diffable, 'add', 'added.txt');
  await git(diffable, 'rm', '--quiet', 'delete-me.txt');
  await git(diffable, 'mv', 'rename-me.txt', 'renamed.txt');
  await write(
    diffable,
    'renamed.txt',
    'line one\nline two\nline three\nline four\nline five\nline six\nline seven\nline EIGHT\n',
  );
  // A NUL byte is what makes git call a file binary, whatever the extension says.
  await write(diffable, 'image.png', 'PNG\u0000\u0001\u0002\u0003not really an image');
  await git(diffable, 'add', 'image.png');
  await write(diffable, 'no-newline.txt', 'trailing text changed');

  // --- 8. a remote that exists: upstream, ahead and behind are real numbers ---
  const upstream = await create('upstream');
  await write(upstream, 'file.txt', 'first\n');
  await commit(upstream, 'first');
  const bare = join(base, 'upstream.git');
  await git(base, 'init', '--bare', '--quiet', bare);
  await git(upstream, 'remote', 'add', 'origin', bare);
  await git(upstream, 'push', '--quiet', '-u', 'origin', 'main');
  await git(upstream, 'branch', 'no-upstream');
  await write(upstream, 'file.txt', 'second\n');
  await commit(upstream, 'second');
  // Commit on the remote side so `behind` is not zero either.
  const other = join(base, 'other-clone');
  await git(base, 'clone', '--quiet', bare, other);
  await git(other, 'config', 'user.name', 'Other');
  await git(other, 'config', 'user.email', 'other@example.invalid');
  await write(other, 'remote-only.txt', 'remote\n');
  await commit(other, 'a commit only the remote has');
  await git(other, 'push', '--quiet', 'origin', 'main');
  await git(upstream, 'fetch', '--quiet', 'origin');

  const version = await git(base, '--version');

  return {
    fixtures,
    gitVersion: version.stdout.trim(),
    cleanup: async () => {
      await rm(base, { recursive: true, force: true });
    },
  };
}
