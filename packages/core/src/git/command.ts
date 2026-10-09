/**
 * The one place where the product decides what `git` is allowed to be asked to do.
 *
 * Everything else — the desktop app, the CLI, an agent over MCP — builds one of these
 * values and hands it to `execute`. There is no other code path that spawns a process,
 * which is what makes the invariants in `docs/INVARIANTS.md` enforceable rather than
 * aspirational.
 */

/** How bad a mistake this command can be. `destructive` needs a confirmation token. */
export type Risk = 'read' | 'local' | 'remote' | 'destructive';

/**
 * The refs that name an operation git is in the middle of.
 *
 * The long form of these three reads belongs to `toArgv` and to nowhere else. Every other
 * place — `readPendingOperation`, a test, a future front-end — goes through the command
 * union, because a second copy of `rev-parse -q --verify` is how the two start drifting.
 */
export type PendingRef = 'MERGE_HEAD' | 'CHERRY_PICK_HEAD' | 'REBASE_HEAD';

export type GitCommand =
  // --- read: the working tree and the graph, unchanged ---
  | { readonly op: 'version' }
  | { readonly op: 'repo-root' }
  | { readonly op: 'status' }
  | { readonly op: 'graph'; readonly limit: number; readonly all?: boolean; readonly rev?: string }
  | { readonly op: 'count'; readonly all?: boolean; readonly rev?: string }
  | { readonly op: 'refs' }
  | { readonly op: 'stash-list' }
  | {
      readonly op: 'diff';
      readonly rev?: string;
      readonly cached?: boolean;
      readonly path?: string;
    }
  | { readonly op: 'commit-detail'; readonly rev: string }
  | { readonly op: 'commit-patch'; readonly rev: string }
  /** One of the pending-operation refs. See `toArgv` for why it is three commands. */
  | { readonly op: 'pending-operation'; readonly ref: PendingRef }
  // --- local: changes the repository on this disk ---
  | { readonly op: 'add'; readonly paths: readonly string[] }
  | { readonly op: 'unstage'; readonly paths: readonly string[] }
  | { readonly op: 'commit'; readonly message: string; readonly amend?: boolean }
  | { readonly op: 'branch-create'; readonly name: string; readonly start?: string }
  | { readonly op: 'checkout'; readonly ref: string; readonly detach?: boolean }
  | { readonly op: 'tag-create'; readonly name: string; readonly rev: string }
  | { readonly op: 'merge'; readonly ref: string }
  | { readonly op: 'stash-push'; readonly message?: string }
  | { readonly op: 'stash-pop' }
  | { readonly op: 'branch-delete'; readonly name: string; readonly force?: boolean }
  // --- remote: talks to another machine (through git, never from here) ---
  | { readonly op: 'fetch'; readonly remote?: string }
  | { readonly op: 'pull' }
  | {
      readonly op: 'push';
      readonly remote: string;
      readonly branch: string;
      readonly force?: boolean;
    }
  // --- destructive: unrecoverable without reflog/backup ---
  | { readonly op: 'reset-hard'; readonly rev: string }
  | { readonly op: 'clean' }
  | { readonly op: 'discard'; readonly paths: readonly string[] };

export type GitOp = GitCommand['op'];

/**
 * Exhaustive by construction: there is no `default` branch, so adding an op to
 * `GitCommand` without giving it a risk is a compile error, not a silent `'read'`.
 * A new operation can only ever be *more* careful than the compiler allows.
 */
export function riskOf(cmd: GitCommand): Risk {
  switch (cmd.op) {
    case 'version':
    case 'repo-root':
    case 'status':
    case 'graph':
    case 'count':
    case 'refs':
    case 'stash-list':
    case 'diff':
    case 'commit-detail':
    case 'commit-patch':
    case 'pending-operation':
      return 'read';

    case 'add':
    case 'unstage':
    case 'commit':
    case 'branch-create':
    case 'checkout':
    case 'tag-create':
    case 'merge':
    case 'stash-push':
    case 'stash-pop':
      return 'local';

    // `git branch -d` refuses to delete an unmerged branch; `-D` does not.
    case 'branch-delete':
      return cmd.force === true ? 'destructive' : 'local';

    case 'fetch':
    case 'pull':
      return 'remote';

    // A forced push rewrites what everyone else may already have.
    case 'push':
      return cmd.force === true ? 'destructive' : 'remote';

    case 'reset-hard':
    case 'clean':
    case 'discard':
      return 'destructive';
  }
}

export function isDestructive(cmd: GitCommand): boolean {
  return riskOf(cmd) === 'destructive';
}

/**
 * Argument injection, not validation for its own sake: a ref that begins with `-` becomes a
 * flag for `git`, and a ref cannot be quoted away with `--` the way a path can. Whitespace
 * and control characters are refused for the same reason the argv is an array.
 *
 * Everything else — `HEAD~1`, `main..feature`, `v1.0.0` — is git's business. Rejecting a
 * revision expression here would break the product's own features.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: a control character in a ref IS the injection
const REF_UNSAFE = /^-|[\s\u0000-\u001f]/;

/** Returns the ref, so it can be used inline while still being checked. */
export function assertSafeRef(ref: string): string {
  if (ref === '' || REF_UNSAFE.test(ref)) {
    throw new InvalidArgumentError(`refusing to pass a ref that git would read as a flag: ${ref}`);
  }
  return ref;
}

function assertSafeName(name: string, what: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: same, for a branch or tag name
  if (name === '' || /[\s\u0000-\u001f]/.test(name) || name.startsWith('-')) {
    throw new InvalidArgumentError(`invalid ${what}: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * A pure function from a command to the exact argv. Being pure is the point: the
 * dangerous lines — `--` before paths, `--force-with-lease` instead of `--force`,
 * `clean -fd` instead of `-fdx` — are assertions in a test rather than hopes.
 */
export function toArgv(cmd: GitCommand): string[] {
  switch (cmd.op) {
    case 'version':
      return ['--version'];

    case 'repo-root':
      return ['rev-parse', '--show-toplevel'];

    case 'status':
      return ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'];

    // `--all` and a named revision are two different questions and are never passed
    // together; the flag wins so the argv cannot accidentally read a second history.
    case 'graph':
      return [
        'log',
        '-z',
        '--topo-order',
        `--max-count=${Math.max(1, Math.floor(cmd.limit))}`,
        ...(cmd.all === true ? ['--all'] : [assertSafeRef(cmd.rev ?? 'HEAD')]),
        `--format=${LOG_FORMAT}`,
      ];

    case 'count':
      return [
        'rev-list',
        '--count',
        ...(cmd.all === true ? ['--all'] : [assertSafeRef(cmd.rev ?? 'HEAD')]),
      ];

    case 'refs':
      return ['for-each-ref', `--format=${REF_FORMAT}`];

    // `%gd` is the selector a caller can hand back to git (`stash apply stash@{0}`), so it is
    // what the list is keyed on; `%s` is free-form and therefore has to be the last field.
    case 'stash-list':
      return ['stash', 'list', `--format=${STASH_FORMAT}`];

    // Three different questions share one git subcommand, and the argv has to be able to ask
    // all three. `--cached <rev>` is the index against a commit; `<rev>` is the working tree
    // against that commit; no revision at all is the working tree against the index, which
    // reads as a missing argument rather than a feature unless it is named here.
    case 'diff':
      return [
        'diff',
        ...(cmd.cached === true
          ? ['--cached', assertSafeRef(cmd.rev ?? 'HEAD')]
          : cmd.rev === undefined
            ? []
            : [assertSafeRef(cmd.rev)]),
        '--no-color',
        '--no-ext-diff',
        '--patch',
        '--find-renames',
        ...(cmd.path === undefined ? [] : ['--', cmd.path]),
      ];

    case 'commit-detail':
      return ['log', '-z', '--max-count=1', `--format=${DETAIL_FORMAT}`, assertSafeRef(cmd.rev)];

    // `--format=` suppresses the commit header so the output is the plain patch `parseDiff`
    // reads. Plain `git show` prints no patch for a merge, and `-m` alone prints one per
    // parent; `--first-parent` is what gives a merge one honest diff, against its first
    // parent. For an ordinary commit the result is byte-identical without those two flags.
    case 'commit-patch':
      return [
        'show',
        '--patch',
        '--format=',
        '-m',
        '--first-parent',
        '--no-color',
        '--no-ext-diff',
        '--find-renames',
        assertSafeRef(cmd.rev),
      ];

    // Three separate commands, not one `rev-parse --verify MERGE_HEAD CHERRY_PICK_HEAD
    // REBASE_HEAD`: a multi-argument `--verify` stops at the first name that is missing and
    // exits 1, so a single call cannot say *which* of the three exist. The caller knows this
    // because it asks three times, in the order documented in `PENDING_ORDER`.
    case 'pending-operation':
      return ['rev-parse', '-q', '--verify', cmd.ref];

    case 'add':
      return ['add', '--', ...assertSafePaths(cmd.paths)];

    case 'unstage':
      return ['restore', '--staged', '--', ...assertSafePaths(cmd.paths)];

    case 'commit':
      if (cmd.message.trim() === '') {
        throw new InvalidArgumentError('a commit needs a message');
      }
      return ['commit', '-m', cmd.message, ...(cmd.amend === true ? ['--amend'] : [])];

    case 'branch-create':
      assertSafeName(cmd.name, 'branch name');
      return ['branch', cmd.name, ...(cmd.start === undefined ? [] : [assertSafeRef(cmd.start)])];

    case 'checkout':
      return ['switch', ...(cmd.detach === true ? ['--detach'] : []), assertSafeRef(cmd.ref)];

    case 'tag-create':
      assertSafeName(cmd.name, 'tag name');
      return ['tag', cmd.name, assertSafeRef(cmd.rev)];

    case 'merge':
      return ['merge', '--no-edit', assertSafeRef(cmd.ref)];

    case 'stash-push':
      return ['stash', 'push', ...(cmd.message === undefined ? [] : ['-m', cmd.message])];

    case 'stash-pop':
      return ['stash', 'pop'];

    case 'branch-delete':
      assertSafeName(cmd.name, 'branch name');
      return ['branch', cmd.force === true ? '-D' : '-d', cmd.name];

    case 'fetch':
      return ['fetch', '--prune', ...(cmd.remote === undefined ? [] : [cmd.remote])];

    // `--ff-only` by default: a divergent pull is a decision for the person in front of
    // the screen, not something a background refresh is allowed to resolve by merging.
    case 'pull':
      return ['pull', '--ff-only'];

    case 'push':
      return [
        'push',
        cmd.remote,
        cmd.branch,
        ...(cmd.force === true ? ['--force-with-lease'] : []),
      ];

    case 'reset-hard':
      return ['reset', '--hard', assertSafeRef(cmd.rev)];

    // Never `-x`: that would delete build output and node_modules, which the user did
    // not ask to lose when clicking "clean".
    case 'clean':
      return ['clean', '-fd'];

    case 'discard':
      return ['restore', '--worktree', '--', ...assertSafePaths(cmd.paths)];
  }
}

function assertSafePaths(paths: readonly string[]): readonly string[] {
  if (paths.length === 0) {
    throw new InvalidArgumentError('this operation needs at least one path');
  }
  for (const path of paths) {
    if (path === '' || path.includes('\u0000')) {
      throw new InvalidArgumentError('empty path');
    }
  }
  return paths;
}

/** Field and record separators that cannot appear in a commit subject. */
export const FIELD_SEP = '\u001f';
export const LOG_FORMAT = `%H${FIELD_SEP}%P${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%at${FIELD_SEP}%ct${FIELD_SEP}%s`;

/**
 * Two separators, because `%s` and `%b` are both free-form: one separator could not tell a
 * subject that contains it from the start of the body. The record is split on `DETAIL_SEP`
 * first, and only the head is split on `FIELD_SEP`.
 */
export const DETAIL_SEP = '\u001d';
export const DETAIL_FORMAT = `%H${FIELD_SEP}%P${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%at${FIELD_SEP}%ct${FIELD_SEP}%s${DETAIL_SEP}%b`;
export const REF_FORMAT = `%(refname)${FIELD_SEP}%(objectname)${FIELD_SEP}%(objecttype)${FIELD_SEP}%(HEAD)${FIELD_SEP}%(upstream)${FIELD_SEP}%(symref)`;

/**
 * The stash list: a selector, the stash commit, its timestamp and its free-form subject.
 * The subject is last, so a separator inside it is read as part of the subject rather than
 * as the start of a field.
 */
export const STASH_FORMAT = `%gd${FIELD_SEP}%H${FIELD_SEP}%ct${FIELD_SEP}%s`;

export class InvalidArgumentError extends Error {
  override readonly name = 'InvalidArgumentError';
}
