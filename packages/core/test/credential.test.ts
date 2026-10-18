import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { credentialRequestText, parseCredential } from '../src/git/credential.ts';
import { openRepo, readCredential } from '../src/repo.ts';
import { git } from './support/fixtures.ts';

/**
 * Whether a credential is stored, asked of git's own helper.
 *
 * The helper is a fixture that answers with a known secret, so the test can assert the two halves of
 * the promise: the answer says a credential exists, and **the secret is nowhere in it**. The machine's
 * own configuration is disabled for the same reason the fixtures build their own repositories — a test
 * that read somebody's keychain would be asserting about their laptop.
 */
let root = '';
let beside = '';
let helperConfig = '';

beforeEach(async () => {
  beside = await mkdtemp(join(tmpdir(), 'orbitree-credential-'));
  helperConfig = join(beside, 'helper.config');
  root = join(beside, 'repo');
  await git(beside, 'init', '-b', 'main', '--quiet', root);
  await git(root, 'config', 'user.name', 'Credential Test');
  await git(root, 'config', 'user.email', 'credential@example.invalid');
  await git(root, 'commit', '--allow-empty', '--quiet', '-m', 'the first commit');
});

afterEach(async () => {
  await rm(beside, { recursive: true, force: true });
});

/** The environment a test uses to keep the machine's own helpers out of the answer. */
function only(config: string): NodeJS.ProcessEnv {
  return { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: '/dev/null' };
}

describe('a credential, asked of the helper', () => {
  it('[I8] a stored credential is reported, and the secret is not in the answer', async () => {
    const secret = 's3cret-not-a-token-shape';
    await writeFile(
      helperConfig,
      `[credential]\n\thelper = "!f() { echo username=someone; echo password=${secret}; }; f"\n`,
      'utf8',
    );

    const answer = await readCredential(
      await openRepo(root),
      { protocol: 'https', host: 'example.invalid' },
      { env: only(helperConfig) },
    );
    expect(answer.available).toBe(true);
    expect(answer.username).toBe('someone');
    expect(answer.hasPassword).toBe(true);
    expect(answer.note).toBeNull();
    // The keys git answered with are kept, in order, and the secret is not among them.
    expect(answer.entries.map((entry) => entry.key)).toEqual(['protocol', 'host', 'username']);
    expect(JSON.stringify(answer)).not.toContain(secret);
  });

  it('[I5] nothing stored is an answer, in git’s own words, rather than an error', async () => {
    await writeFile(helperConfig, '', 'utf8');
    const answer = await readCredential(
      await openRepo(root),
      { protocol: 'https', host: 'example.invalid' },
      { env: only(helperConfig) },
    );
    expect(answer.available).toBe(false);
    expect(answer.username).toBeNull();
    expect(answer.hasPassword).toBe(false);
    // Git exits non-zero, and the message is the useful half: it says *why* there is none. The
    // wording is git's own and changes with it — "terminal prompts disabled" up to 2.4x, "unable to
    // get password from user" on 2.54 (Apple Git-157) — so only the fact that the note is git's
    // complaint, and not one of ours, is pinned.
    expect(answer.note).toMatch(/terminal prompts disabled|unable to get password from user/);
    expect(answer.entries).toEqual([]);
  });

  it('an ssh remote has no stored credential, because ssh has no helper to ask', async () => {
    const answer = await readCredential(
      await openRepo(root),
      { protocol: 'ssh', host: 'example.invalid' },
      { env: only(helperConfig) },
    );
    expect(answer.available).toBe(false);
  });

  it('[I4] the request is the protocol git reads, and a broken answer is a value', () => {
    // The blank line is what ends the request; without it git waits.
    expect(credentialRequestText({ protocol: 'https', host: 'github.com' })).toBe(
      'protocol=https\nhost=github.com\n\n',
    );
    expect(
      credentialRequestText({ protocol: 'https', host: 'github.com', path: 'x/y', username: 'me' }),
    ).toContain('path=x/y\nusername=me\n\n');

    // `password` is the one record this parser withholds, and it withholds it in `raw` too — the rule
    // that a parser keeps every record is about git's shape, and this is a deliberate exception with
    // its reason written in the module.
    const parsed = parseCredential(
      'protocol=https\nhost=x\nusername=me\npassword=hunter2\nfuture=1\n',
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value.hasPassword).toBe(true);
    expect(parsed.ok && parsed.value.raw).not.toContain('hunter2');
    expect(parsed.ok && parsed.value.raw).toContain('password=***');
    // A key this version does not know is kept: the shape is not the product's to decide.
    expect(parsed.ok && parsed.value.entries.map((entry) => entry.key)).toEqual([
      'protocol',
      'host',
      'username',
      'future',
    ]);

    expect(parseCredential('not a key value pair\n').ok).toBe(false);
    expect(parseCredential('')).toEqual({
      ok: true,
      value: {
        username: null,
        hasPassword: false,
        entries: [],
        raw: '',
        available: false,
      },
    });
  });
});
