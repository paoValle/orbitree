import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diagnoseFailure } from '../src/git/diagnose.ts';
import { execute } from '../src/git/exec.ts';
import { startGitHttp, type GitHttpServer } from './support/git-http.ts';
import { git } from './support/fixtures.ts';

/**
 * P3's exit criterion, as far as a machine with no forge account can take it: a real push over a real
 * git HTTP transport, with the credential coming from a helper, and the token appearing nowhere.
 *
 * The two things a `file://` remote cannot test are both here. The remote **refuses without a
 * credential**, so the push only succeeds if the helper's answer reached git; and the same fixture,
 * given a wrong answer, is what the failure diagnosis is asked about — a real 401 from a real server
 * rather than a sentence copied out of a manual.
 *
 * What it is not: GitHub or GitLab. A test that pushed to either would need two accounts and two
 * tokens in CI, and it would be testing the forge rather than this product. The transport, the
 * helper, the refusal and the log are the parts this product owns.
 */
let root = '';
let beside = '';
let remote = '';
let server: GitHttpServer | null = null;
const TOKEN = 'a-token-that-is-not-a-known-shape';

beforeEach(async () => {
  beside = await mkdtemp(join(tmpdir(), 'orbitree-credential-push-'));
  root = join(beside, 'src');
  remote = join(beside, 'remote.git');
  await git(beside, 'init', '-b', 'main', '--quiet', root);
  await git(root, 'config', 'user.name', 'Push Test');
  await git(root, 'config', 'user.email', 'push@example.invalid');
  await git(root, 'commit', '--allow-empty', '--quiet', '-m', 'the first commit');
  await git(beside, 'init', '--bare', '-b', 'main', '--quiet', remote);
  // Without this the backend refuses every receive-pack, whatever the credential says.
  await git(remote, 'config', 'http.receivepack', 'true');
});

afterEach(async () => {
  await server?.close();
  server = null;
  await rm(beside, { recursive: true, force: true });
});

/** A helper that answers with this token, as a user's own canned helper would. */
async function helperThatAnswers(token: string): Promise<string> {
  const config = join(beside, 'helper.config');
  await writeFile(
    config,
    `[credential]\n\thelper = "!f() { echo username=someone; echo password=${token}; }; f"\n`,
    'utf8',
  );
  return config;
}

const env = (config: string): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_CONFIG_GLOBAL: config,
  // The machine's own helpers are taken out of the answer: a test that read somebody's keychain
  // would be asserting about their laptop.
  GIT_CONFIG_SYSTEM: '/dev/null',
});

describe('a push that needs a credential', () => {
  it('[I5] the helper’s answer is what gets past the server, and the token is nowhere in the result', async () => {
    server = await startGitHttp(beside, TOKEN);
    const config = await helperThatAnswers(TOKEN);

    const result = await execute(
      { op: 'push', remote: `${server.url}/remote.git`, branch: 'main' },
      { cwd: root, env: env(config), timeoutMs: 30_000 },
    );
    expect(result.exitCode).toBe(0);
    // The summary is on stderr, with the progress: a push says what it moved there, not on stdout.
    expect(result.stderr).toContain('main -> main');
    expect(server.requests).toBeGreaterThan(0);

    // The push really happened: git's own answer from *inside* the remote, and the commit is the one
    // this repository has.
    const pushed = await git(remote, 'rev-parse', 'main');
    expect(pushed.stdout.trim()).toBe((await git(root, 'rev-parse', 'HEAD')).stdout.trim());

    // And the credential is nowhere the product could show or store it: not in the argv, not in the
    // output, nowhere in the JSON a front-end would print.
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('[I5] without a usable credential the server refuses, and the refusal is recognised', async () => {
    server = await startGitHttp(beside, TOKEN);
    // The helper answers, and answers wrong: this is the token-scope failure a person actually has.
    const config = await helperThatAnswers('the-wrong-token');

    const result = await execute(
      { op: 'push', remote: `${server.url}/remote.git`, branch: 'main' },
      { cwd: root, env: env(config), timeoutMs: 30_000 },
    );
    expect(result.exitCode).not.toBe(0);
    // The server's own refusal, passed through by git, and the sentence the product adds beside it:
    // a token that was refused is the failure a person can actually do something about.
    expect(result.stderr).toContain('authentication required');
    expect(diagnoseFailure(result.stderr)?.kind).toBe('token');
    // Nothing arrived: a refused push leaves the remote where it was, which git answers with exit 1
    // and no output rather than by refusing to run.
    const listed = await git(remote, 'rev-parse', '--verify', '--quiet', 'main');
    expect(listed.code).toBe(1);
    expect(listed.stdout.trim()).toBe('');
  });

  it('[I5] the credential read and the push agree about who answers', async () => {
    server = await startGitHttp(beside, TOKEN);
    const config = await helperThatAnswers(TOKEN);

    // The same helper, asked directly: available, and for the same username the push used.
    const { readCredential } = await import('../src/repo.ts');
    const { openRepo } = await import('../src/repo.ts');
    const answer = await readCredential(
      await openRepo(root),
      { protocol: 'http', host: '127.0.0.1', path: '/remote.git' },
      { env: env(config) },
    );
    expect(answer.available).toBe(true);
    expect(answer.username).toBe('someone');
    expect(answer.hasPassword).toBe(true);
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
  });
});
