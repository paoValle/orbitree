import { describe, expect, it } from 'vitest';
import { toArgv } from '../src/git/command.ts';
import { execute, GitFailedError, gitEnv } from '../src/git/exec.ts';
import { redact } from '../src/git/redact.ts';

describe('secrets on their way out', () => {
  it('[I8] credentials in a remote URL are removed', () => {
    expect(
      redact('fatal: could not read from https://paolo:ghp_AAAABBBBCCCCDDDDEEEE@github.com/x/y'),
    ).not.toContain('ghp_');
    expect(redact('https://user:tok3n@gitlab.example.com:8443/x.git')).toBe(
      'https://***@gitlab.example.com:8443/x.git',
    );
  });

  it('[I8] token shapes are removed wherever they appear', () => {
    const samples = [
      'ghp_ABCDEFGHIJKLMNOPQRST',
      'gho_ABCDEFGHIJKLMNOPQRST',
      'github_pat_11ABCDEFG0abcdefghijklmnop',
      'glpat-abcdefghijklmnopqrst',
      'gldt-abcdefghijklmnopqrst',
      'AKIAIOSFODNN7EXAMPLE',
    ];
    for (const sample of samples) {
      expect(redact(`remote: ${sample} rejected`), sample).not.toContain(sample.slice(0, 8));
    }
    expect(redact('Authorization: Bearer abcdefghijklmnopqrstuv')).toContain('***redacted***');
  });

  it('[I8] the argv a caller is shown has the credential masked', async () => {
    // The credential a UI can leak is not only in stderr: a remote URL holds a token, and both
    // front-ends show the command and let it be copied. What git is given stays exactly as it was
    // built — `toArgv` is pure — and what leaves the process is masked.
    const token = 'ghp_ABCDEFGHIJKLMNOPQRST';
    const command = {
      op: 'push',
      remote: `https://user:${token}@example.invalid/x.git`,
      branch: 'main',
    } as const;
    const planned = await execute(command, { cwd: process.cwd(), dryRun: true });
    expect(planned.argv.join(' ')).not.toContain(token);
    expect(planned.argv.join(' ')).toContain('https://***@example.invalid/x.git');
    expect(toArgv(command).join(' ')).toContain(token);

    // And a failure whose stderr is empty falls back to naming the command, which is the other
    // place the same argv is printed.
    const failed = new GitFailedError(toArgv(command), 128, '');
    expect(failed.message).not.toContain(token);
    expect(failed.message).toContain('https://***@example.invalid/x.git');
  });

  it('[I8] an ordinary message is left alone', () => {
    const message =
      'Your branch is up to date with origin/main. Nothing to commit, working tree clean.';
    expect(redact(message)).toBe(message);
  });

  it('the environment git is given cannot hang on a prompt', () => {
    const env = gitEnv({ HOME: '/home/someone', GIT_TERMINAL_PROMPT: '1' });
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_OPTIONAL_LOCKS).toBe('0');
    expect(env.GIT_PAGER).toBe('cat');
    expect(env.HOME).toBe('/home/someone');
  });
});
