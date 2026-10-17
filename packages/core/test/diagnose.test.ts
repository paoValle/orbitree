import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diagnoseFailure } from '../src/git/diagnose.ts';
import { execute } from '../src/git/exec.ts';

const run = promisify(execFile);

/**
 * What to do about a network failure.
 *
 * The failures a machine can produce on its own are produced here with the real `git` binary — a
 * host nothing listens on, a path that is not a repository, a branch that has moved — and what it
 * printed is what the classifier is asked about. The ones that need a server to refuse a key or a
 * token cannot be produced locally; those are the strings git and OpenSSH print, kept verbatim
 * because a hand-written approximation of somebody else's error message would prove nothing.
 */
let root = '';
let beside = '';
/** A URL nothing answers on: port 9 is the discard port and this machine is not listening. */
const NOWHERE = 'https://127.0.0.1:9/no/such.git';

beforeEach(async () => {
  beside = await mkdtemp(join(tmpdir(), 'orbitree-diagnose-'));
  root = join(beside, 'repo');
  await run('git', ['init', '-b', 'main', '--quiet', root]);
  await run('git', ['config', 'user.name', 'Diagnose Test'], { cwd: root });
  await run('git', ['config', 'user.email', 'diagnose@example.invalid'], { cwd: root });
  await run('git', ['config', 'core.autocrlf', 'false'], { cwd: root });
  await run('git', ['commit', '--allow-empty', '--quiet', '-m', 'the first commit'], { cwd: root });
});

afterEach(async () => {
  await rm(beside, { recursive: true, force: true });
});

describe('a network failure, explained', () => {
  it('[I5] a host nothing answers on is an offline failure, from git’s own words', async () => {
    const result = await execute(
      { op: 'push', remote: NOWHERE, branch: 'main' },
      { cwd: root, timeoutMs: 30_000 },
    );
    expect(result.exitCode).not.toBe(0);
    // What git printed, kept: the advice is said beside it and never instead of it.
    expect(result.stderr).toContain('Failed to connect');
    const diagnosis = diagnoseFailure(result.stderr);
    expect(diagnosis?.kind).toBe('offline');
    expect(diagnosis?.whatToDo).toContain('network');
  });

  it('[I5] a path that is not a repository is named as one', async () => {
    const nowhere = join(beside, 'not-a-repository');
    const result = await execute({ op: 'push', remote: nowhere, branch: 'main' }, { cwd: root });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('does not appear to be a git repository');
    expect(diagnoseFailure(result.stderr)?.kind).toBe('repository-not-found');
  });

  it('[I5] a rejected push is a branch that moved, not a broken network', async () => {
    // A real divergence: the remote moves on independently of this branch.
    const remote = join(beside, 'remote.git');
    await run('git', ['init', '--bare', '--quiet', remote]);
    await run('git', ['remote', 'add', 'origin', remote], { cwd: root });
    await run('git', ['push', '--quiet', 'origin', 'main'], { cwd: root });

    const other = join(beside, 'other');
    await run('git', ['clone', '--quiet', remote, other]);
    await run('git', ['config', 'user.name', 'Other'], { cwd: other });
    await run('git', ['config', 'user.email', 'other@example.invalid'], { cwd: other });
    await run('git', ['commit', '--allow-empty', '--quiet', '-m', 'somebody else'], { cwd: other });
    await run('git', ['push', '--quiet', 'origin', 'main'], { cwd: other });

    await run('git', ['commit', '--allow-empty', '--quiet', '-m', 'and me'], { cwd: root });
    const rejected = await execute({ op: 'push', remote: 'origin', branch: 'main' }, { cwd: root });
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stderr).toContain('rejected');
    const diagnosis = diagnoseFailure(rejected.stderr);
    expect(diagnosis?.kind).toBe('diverged');
    expect(diagnosis?.whatToDo).toContain('pull');
  });

  it('[I5] a local failure is told nothing about', async () => {
    // Not a general error explainer: a revision that does not resolve needs no advice, and a
    // front-end that showed any would be guessing.
    const local = await execute(
      { op: 'reset-hard', rev: 'no-such-revision' },
      { cwd: root, confirmation: { confirmedBy: 'test', reason: 'because', at: 'now' } },
    );
    expect(local.exitCode).not.toBe(0);
    expect(diagnoseFailure(local.stderr)).toBeNull();
  });

  it('[I4] the failures a server has to produce are recognised from its own wording', () => {
    // Verbatim from OpenSSH, git and the two forges. A repository cannot make a server refuse a key,
    // so these strings are the input, and the assertion is about which advice comes back.
    expect(
      diagnoseFailure(
        'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
      )?.kind,
    ).toBe('ssh-key');
    expect(
      diagnoseFailure(
        '@@@@@@@@@@\nHost key verification failed.\nfatal: Could not read from remote repository.',
      )?.kind,
    ).toBe('host-key');
    expect(
      diagnoseFailure(
        "remote: HTTP Basic: Access denied. The provided password or token is incorrect or your account has 2FA enabled.\nfatal: Authentication failed for 'https://gitlab.com/x/y.git/'",
      )?.kind,
    ).toBe('token');
    expect(
      diagnoseFailure(
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      )?.kind,
    ).toBe('token');
    expect(
      diagnoseFailure(
        "remote: Repository not found.\nfatal: repository 'https://github.com/x/y.git/' not found",
      )?.kind,
    ).toBe('repository-not-found');
    expect(
      diagnoseFailure('remote: error: GH006: Protected branch update failed for refs/heads/main.')
        ?.kind,
    ).toBe('refused-by-server');
    // And the three that fail for a reason nobody can explain away are silent.
    expect(diagnoseFailure('')).toBeNull();
    expect(diagnoseFailure('CONFLICT (content): Merge conflict in a.txt')).toBeNull();
    expect(diagnoseFailure("fatal: pathspec 'nope' did not match any files")).toBeNull();
  });
});
