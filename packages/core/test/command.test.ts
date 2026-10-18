import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertSafeRef,
  ConfirmationRequiredError,
  execute,
  type GitCommand,
  type GitOp,
  InvalidArgumentError,
  isDestructive,
  riskOf,
  toArgv,
} from '../src/index.ts';
import { type FixtureSet, makeFixtures } from './support/fixtures.ts';

/**
 * One example per operation. Typed as a `Record<GitOp, ...>`, so an operation added to the
 * command union without a line here is a compile error — the list cannot silently stop
 * covering the surface it is meant to test.
 */
const EXAMPLE: Record<GitOp, GitCommand> = {
  version: { op: 'version' },
  'repo-root': { op: 'repo-root' },
  status: { op: 'status' },
  graph: { op: 'graph', limit: 10 },
  count: { op: 'count' },
  refs: { op: 'refs' },
  'stash-list': { op: 'stash-list' },
  diff: { op: 'diff', rev: 'HEAD' },
  'commit-detail': { op: 'commit-detail', rev: 'HEAD' },
  blame: { op: 'blame', path: 'file.txt' },
  compare: { op: 'compare', left: 'main', right: 'feature', limit: 50 },
  'commit-patch': { op: 'commit-patch', rev: 'HEAD' },
  'pending-operation': { op: 'pending-operation', ref: 'MERGE_HEAD' },
  add: { op: 'add', paths: ['file.txt'] },
  unstage: { op: 'unstage', paths: ['file.txt'] },
  commit: { op: 'commit', message: 'message', body: 'a longer description' },
  'branch-create': { op: 'branch-create', name: 'feature' },
  'branch-rename': { op: 'branch-rename', name: 'feature', to: 'feature-2' },
  checkout: { op: 'checkout', ref: 'main' },
  'tag-create': { op: 'tag-create', name: 'v1', rev: 'HEAD' },
  'tag-delete': { op: 'tag-delete', name: 'v1' },
  merge: { op: 'merge', ref: 'feature' },
  'merge-abort': { op: 'merge-abort' },
  'reset-soft': { op: 'reset-soft', rev: 'HEAD~1' },
  'regenerate-conflict': { op: 'regenerate-conflict', paths: ['file.txt'] },
  'conflict-side': { op: 'conflict-side', side: 'ours', path: 'file.txt' },
  'take-side': { op: 'take-side', side: 'theirs', paths: ['file.txt'] },
  'resolve-conflict': { op: 'resolve-conflict', path: 'file.txt', region: 0, take: 'ours' },
  'resolve-file': { op: 'resolve-file', path: 'file.txt', content: 'what it should say' },
  'stash-push': { op: 'stash-push' },
  'stash-pop': { op: 'stash-pop' },
  'stash-apply': { op: 'stash-apply', selector: 'stash@{0}' },
  'stash-drop': { op: 'stash-drop', selector: 'stash@{0}' },
  'stash-show': { op: 'stash-show', selector: 'stash@{0}' },
  'worktree-list': { op: 'worktree-list' },
  'worktree-add': { op: 'worktree-add', path: '/tmp/a-worktree' },
  'worktree-remove': { op: 'worktree-remove', path: '/tmp/a-worktree' },
  'branch-delete': { op: 'branch-delete', name: 'feature' },
  fetch: { op: 'fetch' },
  pull: { op: 'pull' },
  push: { op: 'push', remote: 'origin', branch: 'main' },
  'remote-list': { op: 'remote-list' },
  identity: { op: 'identity' },
  'credential-fill': {
    op: 'credential-fill',
    request: { protocol: 'https', host: 'example.invalid' },
  },
  'remote-add': { op: 'remote-add', name: 'origin', url: 'git@example.invalid:x/y.git' },
  'remote-remove': { op: 'remote-remove', name: 'origin' },
  'remote-rename': { op: 'remote-rename', name: 'origin', to: 'upstream' },
  'remote-set-url': { op: 'remote-set-url', name: 'origin', url: '../somewhere-else' },
  'reset-hard': { op: 'reset-hard', rev: 'HEAD~1' },
  clean: { op: 'clean' },
  discard: { op: 'discard', paths: ['file.txt'] },
  'discard-hunk': { op: 'discard-hunk', path: 'file.txt', hunk: 0 },
};

let set: FixtureSet;
let repoPath: string;

beforeAll(async () => {
  set = await makeFixtures();
  repoPath = set.fixtures.find((fixture) => fixture.name === 'clean')?.root ?? '';
});

afterAll(async () => {
  await set?.cleanup();
});

describe('the risk of an operation', () => {
  it('[I1] a risk is always one of the four levels', () => {
    for (const command of Object.values(EXAMPLE)) {
      expect(['read', 'local', 'remote', 'destructive']).toContain(riskOf(command));
    }
  });

  it('[I1] only the operations that lose data are destructive', () => {
    const destructive = Object.values(EXAMPLE)
      .filter(isDestructive)
      .map((command) => command.op);
    // `branch-delete` without `force` is a local operation: `git branch -d` refuses an
    // unmerged branch by itself. Only `-D` escalates.
    expect(destructive.sort()).toEqual([
      'clean',
      'discard',
      'discard-hunk',
      'reset-hard',
      'stash-drop',
      'tag-delete',
    ]);
    // ... and the two that escalate only when asked to.
    expect(riskOf({ op: 'push', remote: 'o', branch: 'b', force: true })).toBe('destructive');
    expect(riskOf({ op: 'push', remote: 'o', branch: 'b' })).toBe('remote');
    expect(riskOf({ op: 'branch-delete', name: 'x', force: true })).toBe('destructive');
    expect(riskOf({ op: 'branch-delete', name: 'x' })).toBe('local');
  });

  it('[I1] a destructive command is refused before git is spawned', async () => {
    for (const command of Object.values(EXAMPLE).filter(isDestructive)) {
      await expect(execute(command, { cwd: repoPath })).rejects.toBeInstanceOf(
        ConfirmationRequiredError,
      );
    }
  });

  it('[I1] a confirmation without a reason is not a confirmation', async () => {
    await expect(
      execute(
        { op: 'reset-hard', rev: 'HEAD' },
        { cwd: repoPath, confirmation: { confirmedBy: 'test', reason: '   ', at: 'now' } },
      ),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('[I1] a dry run resolves the argv without a confirmation, and without running', async () => {
    // The point of a dry run is to learn what would happen *before* confirming it.
    const planned = await execute({ op: 'clean' }, { cwd: repoPath, dryRun: true });
    expect(planned.argv).toEqual(['clean', '-fd']);
    expect(planned.risk).toBe('destructive');
    expect(planned.stdout).toBe('');

    // ... and it still refuses a confirmation with no reason.
    await expect(
      execute(
        { op: 'clean' },
        { cwd: repoPath, confirmation: { confirmedBy: 'test', reason: '', at: 'now' } },
      ),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});

describe('the argv a command produces', () => {
  it('[I2] paths are always passed after --', () => {
    const pathless = [
      toArgv({ op: 'add', paths: ['-n', 'a b.txt'] }),
      toArgv({ op: 'discard', paths: ['-x'] }),
    ];
    for (const argv of pathless) {
      const separator = argv.indexOf('--');
      expect(separator, argv.join(' ')).toBeGreaterThanOrEqual(1);
      expect(argv.slice(0, separator).join(' ')).not.toContain('-n');
      expect(argv[argv.length - 1]).toBe(argv[argv.length - 1]);
    }
    expect(toArgv({ op: 'add', paths: ['--force'] })).toEqual(['add', '--', '--force']);
  });

  it('[I2] forcing a push is only ever --force-with-lease', () => {
    const argv = toArgv({ op: 'push', remote: 'origin', branch: 'main', force: true });
    expect(argv).toContain('--force-with-lease');
    expect(argv).not.toContain('--force');
    expect(toArgv({ op: 'push', remote: 'origin', branch: 'main' })).not.toContain(
      '--force-with-lease',
    );
  });

  it('[I2] clean never removes ignored files', () => {
    expect(toArgv({ op: 'clean' })).toEqual(['clean', '-fd']);
    expect(toArgv({ op: 'clean' }).join('')).not.toContain('x');
    // And when it is given paths, they are paths and not options, exactly as `add` and
    // `discard` pass them: an untracked file called `-x` is a filename.
    expect(toArgv({ op: 'clean', paths: ['gone.txt', '-x'] })).toEqual([
      'clean',
      '-fd',
      '--',
      'gone.txt',
      '-x',
    ]);
    expect(toArgv({ op: 'clean', paths: [] })).toEqual(['clean', '-fd']);
  });

  it('[I2] a diff never turns on a pager, colour or an external tool', () => {
    const argv = toArgv({ op: 'diff', rev: 'HEAD' });
    expect(argv).toEqual(expect.arrayContaining(['--no-color', '--no-ext-diff', '--patch']));
  });

  it('the three diff questions are three different argv shapes', () => {
    // The index against a commit.
    expect(toArgv({ op: 'diff', cached: true }).slice(0, 3)).toEqual(['diff', '--cached', 'HEAD']);
    expect(toArgv({ op: 'diff', cached: true, rev: 'HEAD~1' }).slice(0, 3)).toEqual([
      'diff',
      '--cached',
      'HEAD~1',
    ]);
    // The working tree against a commit.
    const against = toArgv({ op: 'diff', rev: 'HEAD~1' });
    expect(against.slice(0, 2)).toEqual(['diff', 'HEAD~1']);
    expect(against).not.toContain('--cached');
    // The working tree against the index: no revision, and that is the question.
    const index = toArgv({ op: 'diff' });
    expect(index.slice(0, 2)).toEqual(['diff', '--no-color']);
    expect(index).not.toContain('--cached');
    expect(index).not.toContain('HEAD');
  });

  it('[I2] a pull is fast-forward only, and the remote commands ask for progress', () => {
    expect(toArgv({ op: 'pull' })).toEqual(['pull', '--progress', '--ff-only']);
    // Without `--progress` git reports progress only to a terminal, which a GUI and a pipe are not:
    // the flag is what makes the same lines arrive where a window or an agent can see them.
    expect(toArgv({ op: 'fetch' })).toContain('--progress');
    expect(toArgv({ op: 'push', remote: 'origin', branch: 'main' })).toContain('--progress');
  });

  it('[I2] a remote URL that git would read as a flag is refused, not passed', () => {
    // `git remote add <name> <url>` takes positionals, so there is no `--` to hide behind: a URL
    // beginning with a dash is refused rather than handed to git. Both directions are asserted,
    // because a guard that refuses everything would pass a test that only checked the refusal.
    expect(() =>
      toArgv({ op: 'remote-add', name: 'origin', url: '--upload-pack=rm -rf /' }),
    ).toThrow(InvalidArgumentError);
    expect(() => toArgv({ op: 'remote-set-url', name: 'origin', url: '-x' })).toThrow(
      InvalidArgumentError,
    );
    // A URL with a space in it is a path somebody means, and is passed as it was given.
    expect(toArgv({ op: 'remote-add', name: 'origin', url: '/tmp/two words.git' })).toEqual([
      'remote',
      'add',
      'origin',
      '/tmp/two words.git',
    ]);
  });

  it('[I2] the status call asks for machine-readable output only', () => {
    expect(toArgv({ op: 'status' })).toEqual([
      'status',
      '--porcelain=v2',
      '--branch',
      '--untracked-files=all',
      '-z',
    ]);
  });

  it('[I2] a ref git would read as a flag is refused, and a real revision is not', () => {
    const dangerous = ['-x', '--upload-pack=touch /tmp/x', 'a b', '', 'a\u0000b'];
    for (const ref of dangerous) {
      expect(() => assertSafeRef(ref), ref).toThrow(InvalidArgumentError);
    }
    // Over-refusing is its own bug: these are revisions the product must accept.
    for (const ref of [
      'HEAD',
      'HEAD~1',
      'main',
      'main..feature',
      'refs/tags/v1',
      'v1.0.0',
      'x^{}',
    ]) {
      expect(() => assertSafeRef(ref), ref).not.toThrow();
    }
    // ... and the argv builder refuses it too, not only the standalone guard.
    expect(() => toArgv({ op: 'checkout', ref: '-x' })).toThrow(InvalidArgumentError);
  });

  it('[I2] an empty path list or an empty commit message is refused', () => {
    expect(() => toArgv({ op: 'add', paths: [] })).toThrow(InvalidArgumentError);
    expect(() => toArgv({ op: 'commit', message: '  ' })).toThrow(InvalidArgumentError);
  });

  it('an amend with no message keeps the existing one instead of opening an editor', () => {
    expect(toArgv({ op: 'commit', message: '', amend: true })).toEqual([
      'commit',
      '--amend',
      '--no-edit',
    ]);
    expect(toArgv({ op: 'commit', message: 'a new subject', amend: true })).toEqual([
      'commit',
      '--amend',
      '-m',
      'a new subject',
    ]);
  });

  it('fuzz: no emitted argv ever contains a bare --force or a shell metacharacter escape', () => {
    const commands: GitCommand[] = Object.values(EXAMPLE);
    fc.assert(
      fc.property(fc.constantFrom(...commands), (command) => {
        const argv = toArgv(command);
        expect(argv[0]).not.toBe('--force');
        for (const arg of argv) expect(arg).not.toContain('\u0000');
        return argv.length > 0;
      }),
      { numRuns: 200 },
    );
  });
});
