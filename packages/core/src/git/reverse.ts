import type { GitCommand } from './command.ts';

/**
 * The command that reverses one operation, given the state it started from.
 *
 * "Every change is listed with the command that reverses it" needs one thing the record of a run
 * does not have on its own: what the repository looked like *before*. A `reset --hard` is only
 * undoable if somebody wrote down where HEAD was; a deleted branch is only recoverable if somebody
 * wrote down what it pointed at. So this takes that state as an argument rather than guessing it.
 *
 * The answer is a **command**, not a line to read: every reverse it names is an operation this
 * product has, so the window can run it through the same guarded path as anything else and the CLI
 * can be handed it. `null` means there is nothing to undo with — either the operation destroyed work
 * nothing git knows can bring back, or its reverse is a decision (a force push) rather than a
 * command.
 */
export interface BeforeState {
  /** The commit HEAD pointed at, or `null` in a repository with no commits yet. */
  readonly head: string | null;
  /** The branch that was checked out, or `null` when HEAD was detached. */
  readonly branch: string | null;
  /** Every local branch and tag by name, as it was before the operation. */
  readonly targets: Readonly<Record<string, string>>;
}

/**
 * Nothing is known about the state before, which is the truth for a record written by an older
 * version of an app, or for a caller that only has the command.
 */
export const BEFORE_NOTHING: BeforeState = { head: null, branch: null, targets: {} };

const backTo = (rev: string | null, mode: 'soft' | 'hard'): GitCommand | null =>
  rev === null ? null : mode === 'soft' ? { op: 'reset-soft', rev } : { op: 'reset-hard', rev };

export function reverseOf(cmd: GitCommand, before: BeforeState): GitCommand | null {
  switch (cmd.op) {
    // The index and the working tree, which are two questions rather than one: staging is undone by
    // restoring the index, and unstaging by adding again.
    case 'add':
      return { op: 'unstage', paths: cmd.paths };
    case 'unstage':
      return { op: 'add', paths: cmd.paths };

    // `--soft`, because the work is only in that commit: a hard reset here would throw away
    // everything the commit was made of, which is not what "undo the commit" means.
    case 'commit':
      return backTo(before.head, 'soft');

    // A merge and a pull both end by moving the branch to a commit whose content is already on the
    // branch that came in, so `--hard` discards the merge itself and nothing else. It also covers
    // the merge that stopped on a conflict: there is no commit to be soft about, and a hard reset
    // is what puts the conflict, the markers and the index back where they were.
    case 'merge':
    case 'pull':
    case 'reset-hard':
      return backTo(before.head, 'hard');

    case 'branch-create':
      return { op: 'branch-delete', name: cmd.name };
    case 'branch-rename':
      return { op: 'branch-rename', name: cmd.to, to: cmd.name };
    case 'branch-delete': {
      const at = before.targets[cmd.name];
      // Without the sha the branch pointed at there is nothing to recreate it from, and deleting a
      // branch that is not there is worse than saying nothing: the answer is null.
      return at === undefined ? null : { op: 'branch-create', name: cmd.name, start: at };
    }

    case 'tag-create':
      return { op: 'tag-delete', name: cmd.name };
    case 'tag-delete': {
      const at = before.targets[cmd.name];
      return at === undefined ? null : { op: 'tag-create', name: cmd.name, rev: at };
    }

    case 'checkout':
      if (before.branch !== null) return { op: 'checkout', ref: before.branch };
      return before.head === null ? null : { op: 'checkout', ref: before.head, detach: true };

    // A stash that was pushed can be popped; one that was popped can be pushed again, though that
    // is a new entry with a new sha, which is why the line is worth reading before it is copied.
    case 'stash-push':
      return { op: 'stash-pop' };
    case 'stash-pop':
      return { op: 'stash-push' };

    // A conflict is resolvable backwards: the index stages are still there until the path is added,
    // so `checkout -m` regenerates the markers from them.
    case 'take-side':
      return { op: 'regenerate-conflict', paths: cmd.paths };
    case 'resolve-conflict':
      return { op: 'regenerate-conflict', paths: [cmd.path] };

    // Nothing brings these back: `clean`, `discard` and `discard-hunk` remove work that was never
    // committed, and a dropped stash is gone unless somebody wrote down its sha — which the record
    // of a run does not carry.
    case 'clean':
    case 'discard':
    case 'discard-hunk':
    case 'stash-drop':
    // A stash applied into the tree is undone by discarding that change, which destroys it: a
    // different decision, and not one to take on somebody's behalf.
    case 'stash-apply':
    // The merge that was given up is not in the record, so recreating it would be a guess.
    case 'merge-abort':
    // Fetch moves remote-tracking refs and nothing of the person's; a push is undone by a force
    // push, which is a decision rather than a line to copy.
    case 'fetch':
    case 'push':
    // Reads change nothing.
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
    case 'stash-show':
    case 'conflict-side':
    // A soft reset moves a pointer that is still in the reflog, and putting the markers back is the
    // one thing `regenerate-conflict` does; neither has a reverse of its own here because the record
    // of the run that made it does.
    case 'reset-soft':
    case 'regenerate-conflict':
    case 'worktree-list':
    case 'blame':
      return null;
    // Adding a worktree adds a directory; removing one takes it away, and putting it back is
    // adding it again — with the branch it was on, which is where the care goes.
    case 'worktree-add':
      return { op: 'worktree-remove', path: cmd.path };
    case 'worktree-remove':
      return { op: 'worktree-add', path: cmd.path };
    // A file an editor wrote is undone by the same command that put the conflict back: the stages
    // are still in the index until the path is added.
    case 'resolve-file':
      return { op: 'regenerate-conflict', paths: [cmd.path] };

    // Adding a remote and renaming one are undone by their own opposites, both of which carry the
    // name. Removing one and pointing it somewhere else are not: the URL that was there is in
    // neither command, and adding a name back with a guessed URL is a different remote than the
    // one that was removed.
    case 'remote-add':
      return { op: 'remote-remove', name: cmd.name };
    case 'remote-rename':
      return { op: 'remote-rename', name: cmd.to, to: cmd.name };
    case 'remote-remove':
    case 'remote-set-url':
    case 'remote-list':
    // Asking a helper for a credential changes nothing this product can reverse, and the credential
    // itself is not held: there is nothing to put back.
    case 'credential-fill':
    // The identity is read and never written by this product: changing it is `config --set`,
    // which is not an operation here yet.
    case 'identity':
      return null;
  }
}
