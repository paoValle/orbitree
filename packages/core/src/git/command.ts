import type { CredentialRequest } from './credential.ts';
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
  | {
      readonly op: 'graph';
      readonly limit: number;
      readonly all?: boolean;
      readonly rev?: string;
      /**
       * Only the commits that touched this path: the file's own history.
       *
       * Git's own simplification, not this product's: a merge whose result matches one side is not a
       * commit that changed the path, so it is not in the answer.
       */
      readonly path?: string;
      /**
       * Revisions to read as well as the main one, and to count as well.
       *
       * A stash older than the newest is reachable from nothing but the reflog of `refs/stash`, so
       * `--all` does not reach it and the only way to draw it is to name it. Kept general because
       * the caller decides what else belongs in the picture, and because the count has to name the
       * same revisions or `total` would stop agreeing with the window it describes.
       */
      readonly also?: readonly string[];
    }
  | {
      readonly op: 'count';
      readonly all?: boolean;
      readonly rev?: string;
      readonly also?: readonly string[];
      /** The same path the graph was read with, or `total` would describe another history. */
      readonly path?: string;
    }
  | { readonly op: 'refs' }
  | { readonly op: 'stash-list' }
  | {
      readonly op: 'diff';
      readonly rev?: string;
      readonly cached?: boolean;
      readonly path?: string;
    }
  | { readonly op: 'commit-detail'; readonly rev: string }
  /**
   * The commits one side of a fork has and the other does not, in one read.
   *
   * `--left-right --cherry-pick A...B`: git marks each commit with the side it is only on, and drops
   * the ones whose patch is already on the other side, which is the difference between "these branches
   * have different commits" and "these branches have different *work*".
   */
  | {
      readonly op: 'compare';
      readonly left: string;
      readonly right: string;
      readonly limit: number;
    }
  /**
   * Who wrote each line of one file, and in which commit.
   *
   * `--line-porcelain`: the metadata is repeated per line, so a block is complete on its own and a
   * truncated read cannot shift the blame of the lines above it.
   */
  | { readonly op: 'blame'; readonly path: string; readonly rev?: string }
  | { readonly op: 'commit-patch'; readonly rev: string }
  /** One of the pending-operation refs. See `toArgv` for why it is three commands. */
  | { readonly op: 'pending-operation'; readonly ref: PendingRef }
  // --- local: changes the repository on this disk ---
  | { readonly op: 'add'; readonly paths: readonly string[] }
  | { readonly op: 'unstage'; readonly paths: readonly string[] }
  | {
      readonly op: 'commit';
      /** The summary: the line the graph shows. */
      readonly message: string;
      /**
       * Everything after it, for the reader of the commit rather than for the graph.
       *
       * Passed as a second `-m` rather than joined here, because git is what puts the blank line
       * between them: one place decides what a commit body looks like, and it is git.
       */
      readonly body?: string;
      readonly amend?: boolean;
    }
  | { readonly op: 'branch-create'; readonly name: string; readonly start?: string }
  | { readonly op: 'branch-rename'; readonly name: string; readonly to: string }
  | { readonly op: 'checkout'; readonly ref: string; readonly detach?: boolean }
  | { readonly op: 'tag-create'; readonly name: string; readonly rev: string }
  | { readonly op: 'tag-delete'; readonly name: string }
  | { readonly op: 'merge'; readonly ref: string }
  | { readonly op: 'merge-abort' }
  /** One of the three versions of a conflicted path: the common ancestor, ours, or theirs. */
  | {
      readonly op: 'conflict-side';
      readonly side: 'base' | 'ours' | 'theirs';
      readonly path: string;
    }
  /** Take one side of a conflicted path into the working tree, leaving the conflict in the index. */
  | {
      readonly op: 'take-side';
      readonly side: 'ours' | 'theirs';
      readonly paths: readonly string[];
    }
  /**
   * Resolve one conflict region of one path, by replacing it with one side, both, or the caller's
   * own text. The patch is built from a fresh read of the file, so what a caller supplies is a
   * choice and, at most, the lines of one region.
   */
  /**
   * Replaces a whole file with text a caller decided on, which is what an editor produces.
   *
   * The text is data rather than an argument, and the patch is built from a read of the file: what a
   * caller supplies can only become the *added* lines of that one file.
   */
  | { readonly op: 'resolve-file'; readonly path: string; readonly content: string }
  | {
      readonly op: 'resolve-conflict';
      readonly path: string;
      readonly region: number;
      readonly take: 'ours' | 'theirs' | 'both' | 'custom';
      readonly content?: string;
    }
  | { readonly op: 'stash-push'; readonly message?: string }
  | { readonly op: 'stash-pop'; readonly selector?: string }
  | { readonly op: 'stash-apply'; readonly selector: string }
  | { readonly op: 'stash-drop'; readonly selector: string }
  /** One stash's own patch, for looking at before deciding what to do with it. */
  | { readonly op: 'stash-show'; readonly selector: string }
  /** Every working directory this repository has checked out, this one included. */
  | { readonly op: 'worktree-list' }
  | {
      readonly op: 'worktree-add';
      /** Where the new working directory goes. */
      readonly path: string;
      /** The branch to check out there, or nothing for a new one git names. */
      readonly branch?: string;
    }
  | {
      readonly op: 'worktree-remove';
      readonly path: string;
      /** Removes it even with changes in it, which is why it needs a confirmation. */
      readonly force?: boolean;
    }
  | { readonly op: 'branch-delete'; readonly name: string; readonly force?: boolean }
  /**
   * The identity commits are made with: the name, the email and the signing key in force, each with
   * the file it came from. A read: `git config` prints the config and asks nothing of a machine.
   */
  | { readonly op: 'identity' }
  /**
   * Whether a credential is stored for a host, by asking git's own helper for one.
   *
   * `read` because it changes nothing there is to change — and with a caveat worth stating: it runs
   * the program the user configured as their helper, which may touch a keychain or refresh a token.
   * The product never sees what git printed as a secret; see `parseCredential`.
   */
  | { readonly op: 'credential-fill'; readonly request: CredentialRequest }
  /**
   * The remotes, as they are configured on this disk. Not a read of a machine: `git remote -v`
   * prints what the config says, and nothing here goes near a network.
   */
  | { readonly op: 'remote-list' }
  | { readonly op: 'remote-add'; readonly name: string; readonly url: string }
  /**
   * Forgetting a remote: its config section and the tracking refs under `refs/remotes/<name>`.
   *
   * `local` rather than `destructive`, by the standard the rest of this file uses: `fetch --prune`
   * deletes those same tracking refs and asks nobody, so the product does not treat that copy as
   * work of the person's. What it cannot bring back is the URL, which is why the reverse of this is
   * `null` rather than a guess.
   */
  | { readonly op: 'remote-remove'; readonly name: string }
  | { readonly op: 'remote-rename'; readonly name: string; readonly to: string }
  | { readonly op: 'remote-set-url'; readonly name: string; readonly url: string }
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
  /** Moves HEAD without touching the index or the working tree: the work stays, staged. */
  | { readonly op: 'reset-soft'; readonly rev: string }
  /** Puts a conflict's markers back from the index stages, undoing a resolution. */
  | { readonly op: 'regenerate-conflict'; readonly paths: readonly string[] }
  | {
      readonly op: 'clean';
      /**
       * The paths to clean, or every untracked path when absent.
       *
       * A path is how the working tree discards a file it has never tracked: `restore` is a
       * question about a tracked path and does nothing to one git has never seen, so the only
       * operation that removes an untracked file is this one.
       */
      readonly paths?: readonly string[];
    }
  | { readonly op: 'discard'; readonly paths: readonly string[] }
  | {
      readonly op: 'discard-hunk';
      /**
       * The path whose diff is read to build the patch. It never reaches the argv: what git
       * applies is the patch, and the path is a question asked of the working tree.
       */
      readonly path: string;
      /** The hunk to reverse, counted from 0 in the order the diff prints them. */
      readonly hunk: number;
    };

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
    case 'blame':
    case 'compare':
    case 'pending-operation':
    case 'stash-show':
    case 'conflict-side':
    case 'worktree-list':
    case 'remote-list':
    case 'identity':
    case 'credential-fill':
      return 'read';

    case 'add':
    case 'unstage':
    case 'commit':
    case 'branch-create':
    case 'checkout':
    case 'tag-create':
    case 'branch-rename':
    case 'merge':
    case 'stash-push':
    case 'stash-pop':
    case 'stash-apply':
    case 'merge-abort':
    case 'take-side':
    case 'resolve-conflict':
    // A soft reset moves a pointer and leaves every file alone, and the eight stages of a
    // conflict are still in the index until it is added: both are undoable by the same command
    // in the other direction.
    case 'reset-soft':
    case 'regenerate-conflict':
    case 'resolve-file':
    case 'worktree-add':
    // A remote is a section of the config and a directory of tracking refs, both on this disk.
    case 'remote-add':
    case 'remote-remove':
    case 'remote-rename':
    case 'remote-set-url':
      return 'local';
    // `git worktree remove` refuses a directory with changes in it; `--force` does not, and that is
    // the same deal as `branch -d` against `-D`.
    case 'worktree-remove':
      return cmd.force === true ? 'destructive' : 'local';

    // Dropping a stash is the one stash operation that loses something by itself: `pop` and
    // `apply` put the work back in the working tree first, and `drop` throws it away without
    // putting it anywhere. Nothing refuses it, so the guard is ours.
    case 'stash-drop':
      return 'destructive';

    // `git branch -d` refuses to delete an unmerged branch; `-D` does not.
    case 'branch-delete':
      return cmd.force === true ? 'destructive' : 'local';

    // A tag is a name for a commit and nothing else: `git tag -d` has no `-d`-style safety, so
    // the name is gone the moment it runs and the reflog of a deleted ref is not a place the
    // product can send anybody. The same kind of loss as a forced branch delete, and guarded the
    // same way.
    case 'tag-delete':
      return 'destructive';

    case 'fetch':
    case 'pull':
      return 'remote';

    // A forced push rewrites what everyone else may already have.
    case 'push':
      return cmd.force === true ? 'destructive' : 'remote';

    case 'reset-hard':
    case 'clean':
    case 'discard':
    case 'discard-hunk':
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

/** The `-- <path>` tail of a log or a count, or nothing when no path was named. */
function pathspec(path: string | undefined): readonly string[] {
  return path === undefined ? [] : ['--', ...assertSafePaths([path])];
}

/**
 * A remote URL, refused when git would read it as an option.
 *
 * There is no `--` to hide behind — `git remote add <name> <url>` takes positionals — so a URL
 * beginning with a dash has to be refused here. Everything else is git's business: `../x`, `ssh://`,
 * `git@host:path` and a path with a space in it are all URLs somebody means.
 */
function assertSafeUrl(url: string): string {
  if (url === '' || url.includes('\u0000') || url.startsWith('-')) {
    throw new InvalidArgumentError(`refusing a remote URL git would read as a flag: ${url}`);
  }
  return url;
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
        ...(cmd.also ?? []).map(assertSafeRef),
        `--format=${LOG_FORMAT}`,
        // After `--format=`, and after `--`: a file called `-p` is a path and not a request for a
        // patch, exactly as in `blame`.
        ...pathspec(cmd.path),
      ];

    case 'count':
      return [
        'rev-list',
        '--count',
        ...(cmd.all === true ? ['--all'] : [assertSafeRef(cmd.rev ?? 'HEAD')]),
        ...(cmd.also ?? []).map(assertSafeRef),
        ...pathspec(cmd.path),
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

    // `%m` first, so every record says which side it is only on: the mark is the whole answer, and it
    // is one character of the format rather than a second read that could disagree with the first.
    case 'compare':
      return [
        'log',
        '-z',
        '--topo-order',
        '--left-right',
        '--cherry-pick',
        `--max-count=${Math.max(1, Math.floor(cmd.limit))}`,
        `--format=${COMPARE_FORMAT}`,
        `${assertSafeRef(cmd.left)}...${assertSafeRef(cmd.right)}`,
      ];

    // The path is after `--`, like every other path in this file: a file called `-p` is a filename and
    // not a request for a patch. The revision, when there is one, is what blame walks from.
    case 'blame':
      return [
        'blame',
        '--line-porcelain',
        ...(cmd.rev === undefined ? [] : [assertSafeRef(cmd.rev)]),
        '--',
        ...assertSafePaths([cmd.path]),
      ];

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

    // An amend with no message keeps the existing one. `--no-edit` is what makes that true
    // for a process with no terminal: plain `--amend` would open an editor and wait for it.
    case 'commit': {
      const body = cmd.body === undefined || cmd.body.trim() === '' ? [] : ['-m', cmd.body];
      if (cmd.amend === true) {
        return [
          'commit',
          '--amend',
          ...(cmd.message.trim() === '' ? ['--no-edit'] : ['-m', cmd.message, ...body]),
        ];
      }
      if (cmd.message.trim() === '') {
        throw new InvalidArgumentError('a commit needs a message');
      }
      return ['commit', '-m', cmd.message, ...body];
    }

    case 'branch-create':
      assertSafeName(cmd.name, 'branch name');
      return ['branch', cmd.name, ...(cmd.start === undefined ? [] : [assertSafeRef(cmd.start)])];

    // The two-name form, so the operation does not depend on which branch is checked out: a
    // rename that only worked for the current branch would be a different feature.
    case 'branch-rename':
      assertSafeName(cmd.name, 'branch name');
      assertSafeName(cmd.to, 'branch name');
      return ['branch', '-m', cmd.name, cmd.to];

    case 'checkout':
      return ['switch', ...(cmd.detach === true ? ['--detach'] : []), assertSafeRef(cmd.ref)];

    case 'tag-create':
      assertSafeName(cmd.name, 'tag name');
      return ['tag', cmd.name, assertSafeRef(cmd.rev)];

    case 'tag-delete':
      assertSafeName(cmd.name, 'tag name');
      return ['tag', '-d', cmd.name];

    case 'merge':
      return ['merge', '--no-edit', assertSafeRef(cmd.ref)];

    case 'merge-abort':
      return ['merge', '--abort'];

    case 'reset-soft':
      return ['reset', '--soft', assertSafeRef(cmd.rev)];

    // `-m` regenerates the conflict from the stages the index still holds, which is what undoing a
    // resolution is: no operation of ours writes markers, and git already knows how.
    case 'regenerate-conflict':
      return ['checkout', '-m', '--', ...assertSafePaths(cmd.paths)];

    // `--ours`/`--theirs` write one side of the file and leave the three stages in the index, so
    // nothing is lost: `git checkout -m -- <path>` puts the conflict markers back. That is why
    // this is not destructive, and why marking the path resolved is a separate step (`add`).
    case 'take-side':
      return ['checkout', `--${cmd.side}`, '--', ...assertSafePaths(cmd.paths)];

    // Forward rather than `--reverse`: this patch says what the file should become. It is built
    // from a read of the file, so the lines it removes are the conflict's own.
    case 'resolve-conflict':
    case 'resolve-file':
      return ['apply', '--recount', '--whitespace=nowarn', '-'];

    // `:2:path` is the index stage, and the leading colon is what makes this safe to build from a
    // path: the argument can never be read as a flag, whatever the path starts with. `assertSafeRef`
    // is deliberately not used here — its rule about a leading dash is about paths git would read as
    // options, and a conflicted file may legitimately be called `-leading-dash`.
    case 'conflict-side': {
      if (cmd.path === '' || cmd.path.includes('\u0000')) {
        throw new InvalidArgumentError('empty path');
      }
      const stage = cmd.side === 'base' ? 1 : cmd.side === 'ours' ? 2 : 3;
      return ['show', `:${stage}:${cmd.path}`];
    }

    case 'stash-push':
      return ['stash', 'push', ...(cmd.message === undefined ? [] : ['-m', cmd.message])];

    case 'stash-pop':
      // With a selector it is `pop stash@{1}`, which is apply-then-drop for that entry: the
      // operation is the same one git defines, on the entry the caller named.
      return ['stash', 'pop', ...(cmd.selector === undefined ? [] : [assertSafeRef(cmd.selector)])];

    case 'stash-apply':
      return ['stash', 'apply', assertSafeRef(cmd.selector)];

    case 'stash-drop':
      return ['stash', 'drop', assertSafeRef(cmd.selector)];

    // The patch a stash holds: the stash against the commit it was taken from, so the same shape
    // as any other diff, read by the same parser and drawn by the same pane.
    case 'worktree-list':
      return ['worktree', 'list', '--porcelain'];

    case 'worktree-add':
      // The path is a positional, so a path starting with a dash would be read as an option: unlike
      // `add` and `discard` there is no `--` to hide behind before git has decided, so it is refused.
      if (cmd.path === '' || cmd.path.startsWith('-')) {
        throw new InvalidArgumentError(
          `refusing a worktree path git would read as a flag: ${cmd.path}`,
        );
      }
      return [
        'worktree',
        'add',
        cmd.path,
        ...(cmd.branch === undefined ? [] : [assertSafeRef(cmd.branch)]),
      ];

    case 'worktree-remove':
      if (cmd.path === '' || cmd.path.startsWith('-')) {
        throw new InvalidArgumentError(
          `refusing a worktree path git would read as a flag: ${cmd.path}`,
        );
      }
      return ['worktree', 'remove', ...(cmd.force === true ? ['--force'] : []), cmd.path];

    case 'stash-show':
      return [
        'stash',
        'show',
        '--patch',
        '--no-color',
        '--no-ext-diff',
        assertSafeRef(cmd.selector),
      ];

    case 'branch-delete':
      assertSafeName(cmd.name, 'branch name');
      return ['branch', cmd.force === true ? '-D' : '-d', cmd.name];

    case 'remote-list':
      return ['remote', '-v'];

    // The request itself travels on stdin, which `stdinFor` builds: an argv here would put a host in
    // a place git does not read it from.
    case 'credential-fill':
      return ['credential', 'fill'];

    // `--null` because a value may hold a newline, and `--show-scope`/`--show-origin` because
    // "somebody's name is here" is a different answer from "this name, from this file, is the one in
    // force". The restriction to `user.*` keeps the whole config out of the process's memory.
    case 'identity':
      return ['config', '--null', '--show-origin', '--show-scope', '--get-regexp', '^user\\.'];

    case 'remote-add':
      return ['remote', 'add', assertSafeName(cmd.name, 'remote name'), assertSafeUrl(cmd.url)];

    case 'remote-remove':
      return ['remote', 'remove', assertSafeName(cmd.name, 'remote name')];

    case 'remote-rename':
      return [
        'remote',
        'rename',
        assertSafeName(cmd.name, 'remote name'),
        assertSafeName(cmd.to, 'remote name'),
      ];

    // `set-url` replaces the URL a name points at; the old one is not in the command, which is why
    // `reverseOf` answers `null` for it.
    case 'remote-set-url':
      return ['remote', 'set-url', assertSafeName(cmd.name, 'remote name'), assertSafeUrl(cmd.url)];

    // `--progress` on all three: without it git reports progress only to a terminal, so a GUI or a
    // pipe sees nothing until the command is done — which for a clone-sized fetch is the whole time
    // somebody would want to know whether it is moving.
    case 'fetch':
      return ['fetch', '--progress', '--prune', ...(cmd.remote === undefined ? [] : [cmd.remote])];

    // `--ff-only` by default: a divergent pull is a decision for the person in front of
    // the screen, not something a background refresh is allowed to resolve by merging.
    case 'pull':
      return ['pull', '--progress', '--ff-only'];

    case 'push':
      return [
        'push',
        '--progress',
        cmd.remote,
        cmd.branch,
        ...(cmd.force === true ? ['--force-with-lease'] : []),
      ];

    case 'reset-hard':
      return ['reset', '--hard', assertSafeRef(cmd.rev)];

    // Never `-x`: that would delete build output and node_modules, which the user did
    // not ask to lose when clicking "clean".
    case 'clean':
      return [
        'clean',
        '-fd',
        ...(cmd.paths === undefined || cmd.paths.length === 0
          ? []
          : ['--', ...assertSafePaths(cmd.paths)]),
      ];

    case 'discard':
      return ['restore', '--worktree', '--', ...assertSafePaths(cmd.paths)];

    // The patch arrives on stdin, so no path is in this argv and there is nothing in it to inject
    // into: the pathspec is only ever used to read the diff the patch comes from. `--recount`
    // because the hunk header travels as git printed it, and `--whitespace=nowarn` so a context
    // line whose trailing space was trimmed on the way through a channel is not a failure.
    case 'discard-hunk':
      return ['apply', '--reverse', '--recount', '--whitespace=nowarn', '-'];
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

/**
 * The log format with the side mark in front of it.
 *
 * `%m` is git's own left/right/boundary mark — `<`, `>` or `-` — and putting it in the format rather
 * than parsing the default output is what keeps one parser reading both: the mark is one character of
 * one field, and `parseComparison` strips it and hands the rest to `parseLog`.
 */
export const COMPARE_FORMAT = `%m${LOG_FORMAT}`;

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
