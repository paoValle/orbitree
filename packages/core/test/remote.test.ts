import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execute } from '../src/git/exec.ts';
import { parseRemotes } from '../src/git/remote.ts';
import { openRepo, readRemotes } from '../src/repo.ts';
import { git } from './support/fixtures.ts';

/**
 * Remotes: the names a repository knows for other copies of itself.
 *
 * A remote is configuration, not a conversation — `git remote -v` prints the URLs from the config and
 * asks no machine anything — so every assertion here is about what git's own config says afterwards,
 * including after the commands that change it.
 */
let root = '';
let beside = '';

beforeEach(async () => {
  beside = await mkdtemp(join(tmpdir(), 'orbitree-remotes-'));
  root = join(beside, 'repo');
  await git(beside, 'init', '-b', 'main', '--quiet', root);
  await git(root, 'config', 'core.autocrlf', 'false');
  await git(root, 'config', 'commit.gpgsign', 'false');
  await git(root, 'commit', '--allow-empty', '--quiet', '-m', 'the first commit');
});

afterEach(async () => {
  await rm(beside, { recursive: true, force: true });
});

describe('the remotes a repository has', () => {
  it('[I5] a fresh repository has none, and git agrees', async () => {
    expect(await readRemotes(await openRepo(root))).toEqual([]);
    const listed = await git(root, 'remote');
    expect(listed.stdout.trim()).toBe('');
  });

  it('[I5] a remote is one record with its two URLs', async () => {
    await git(root, 'remote', 'add', 'origin', 'git@example.invalid:x/y.git');
    // A push URL that is not the fetch URL is the case that makes grouping worth doing: git prints
    // two lines and this is one remote.
    await git(root, 'remote', 'set-url', '--push', 'origin', 'git@example.invalid:x/y-push.git');

    const remotes = await readRemotes(await openRepo(root));
    expect(remotes).toHaveLength(1);
    const origin = remotes[0];
    expect(origin?.name).toBe('origin');
    expect(origin?.fetchUrl).toBe('git@example.invalid:x/y.git');
    expect(origin?.pushUrl).toBe('git@example.invalid:x/y-push.git');
    // Nothing is dropped: the lines git printed are kept, one per URL.
    expect(origin?.raw).toHaveLength(2);

    // The cross-check is the config itself, which is what git reads the URLs out of.
    const fromConfig = await git(root, 'config', '--get', 'remote.origin.url');
    expect(origin?.fetchUrl).toBe(fromConfig.stdout.trim());
  });

  it('[I5] adding, renaming, re-pointing and removing are git’s own config afterwards', async () => {
    const repo = await openRepo(root);
    const added = await execute(
      { op: 'remote-add', name: 'origin', url: 'git@example.invalid:x/y.git' },
      { cwd: repo.root },
    );
    expect(added.exitCode).toBe(0);
    expect((await readRemotes(repo)).map((remote) => remote.name)).toEqual(['origin']);

    // Renaming moves the name and keeps the URL.
    const renamed = await execute(
      { op: 'remote-rename', name: 'origin', to: 'upstream' },
      { cwd: repo.root },
    );
    expect(renamed.exitCode).toBe(0);
    expect((await readRemotes(repo)).map((remote) => remote.name)).toEqual(['upstream']);

    const pointed = await execute(
      { op: 'remote-set-url', name: 'upstream', url: '../somewhere-else' },
      { cwd: repo.root },
    );
    expect(pointed.exitCode).toBe(0);
    expect((await git(root, 'config', '--get', 'remote.upstream.url')).stdout.trim()).toBe(
      '../somewhere-else',
    );

    const removed = await execute({ op: 'remote-remove', name: 'upstream' }, { cwd: repo.root });
    expect(removed.exitCode).toBe(0);
    expect(await readRemotes(repo)).toEqual([]);
  });

  it('[I4] a line it cannot read is a value, not an exception', () => {
    // Not a URL line at all, and a name that is only whitespace: both are refused with the record.
    expect(parseRemotes('origin\tsomewhere.git\n').ok).toBe(false);
    expect(parseRemotes('\t(fetch)\n').ok).toBe(false);
    // A remote git prints for something this version does not know is kept as it came: the URL is
    // whatever git put between the tab and the kind, and the grouping does not lose it.
    const odd = parseRemotes('origin\tssh://host/a\tb (fetch)\n');
    expect(odd.ok && odd.value[0]?.fetchUrl).toBe('ssh://host/a\tb');
    expect(parseRemotes('')).toEqual({ ok: true, value: [] });
  });
});
