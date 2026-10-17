import { writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseIdentity } from '../src/git/identity.ts';
import { openRepo, readIdentity } from '../src/repo.ts';
import { git } from './support/fixtures.ts';

/**
 * The identity commits are made with: who, from which file, and which of the two wins.
 *
 * The global config is a temp file named by `GIT_CONFIG_GLOBAL`, never the machine's own: a test that
 * wrote to somebody's real `~/.gitconfig` would change what their next commit is authored as.
 */
let root = '';
let beside = '';
let globalConfig = '';

beforeEach(async () => {
  beside = await mkdtemp(join(tmpdir(), 'orbitree-identity-'));
  globalConfig = join(beside, 'global.config');
  root = join(beside, 'repo');
  await git(beside, 'init', '-b', 'main', '--quiet', root);
  await git(root, 'config', 'core.autocrlf', 'false');
  await git(root, 'config', 'commit.gpgsign', 'false');
  await git(root, 'commit', '--allow-empty', '--quiet', '-m', 'the first commit');
});

afterEach(async () => {
  await rm(beside, { recursive: true, force: true });
});

describe('the identity in force', () => {
  it('[I5] a repository nobody configured has no name, and that is not an error', async () => {
    // An empty global config file, so the machine's own settings do not answer this question.
    await writeFile(globalConfig, '', 'utf8');
    const identity = await readIdentity(await openRepo(root), {
      env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    expect(identity.name).toBeNull();
    expect(identity.email).toBeNull();
    expect(identity.signingKey).toBeNull();
    expect(identity.records).toEqual([]);
  });

  it('[I5] the local name wins, and the record says which file it came from', async () => {
    await writeFile(
      globalConfig,
      '[user]\n\tname = Global Person\n\temail = global@example.invalid\n',
    );
    await git(root, 'config', 'user.name', 'Local Person');
    const identity = await readIdentity(await openRepo(root), {
      env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_SYSTEM: '/dev/null' },
    });

    // Two records for the name, and the one in force is the local one — the same answer
    // `git config user.name` gives, which is the cross-check here.
    expect(identity.records.filter((record) => record.key === 'user.name')).toHaveLength(2);
    expect(identity.name?.value).toBe('Local Person');
    expect(identity.name?.scope).toBe('local');
    expect(identity.name?.origin).toContain('config');
    // The email is only in the global file, so that is where it says it came from.
    expect(identity.email?.value).toBe('global@example.invalid');
    expect(identity.email?.scope).toBe('global');
    expect(identity.email?.origin).toContain('global.config');

    const effective = await git(root, 'config', 'user.name');
    expect(effective.stdout.trim()).toBe(identity.name?.value);
  });

  it('[I4] a record it cannot read is a value, and an unknown user key is kept', () => {
    // One record as git prints it with `--null --show-scope --show-origin`: three NUL-separated
    // fields, the last of which is the key, a newline, and the value.
    const record = (key: string, value: string): string =>
      `local\u0000file:.git/config\u0000${key}\n${value}\u0000`;

    // A record with no key/value separator, and a field count that is not a multiple of three.
    expect(parseIdentity(record('user.name', 'Person').replace('\n', '')).ok).toBe(false);
    expect(parseIdentity('local\u0000file:.git/config').ok).toBe(false);

    // A key this version does not name survives in `records`, which is what keeps a newer git's
    // setting readable by an older product instead of fatal.
    const parsed = parseIdentity(
      record('user.name', 'Person') + record('user.useconfigonly', 'true'),
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value.name?.value).toBe('Person');
    expect(parsed.ok && parsed.value.records.map((entry) => entry.key)).toEqual([
      'user.name',
      'user.useconfigonly',
    ]);
    // A key set to nothing signs nothing, so it is reported as unset rather than as an empty key.
    const empty = parseIdentity(record('user.signingkey', ''));
    expect(empty.ok && empty.value.signingKey).toBeNull();
  });
});
