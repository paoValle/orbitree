import type { GitCommand } from './command.ts';

/**
 * The command that reverses one operation, given the state it started from.
 *
 * "Every change is listed with the command that reverses it" needs one thing the record of a run
 * does not have on its own: what the repository looked like *before*. A `reset --hard` is only
 * undoable if somebody wrote down where HEAD was; a deleted branch is only recoverable if somebody
 * wrote down what it pointed at. So this takes that state as an argument rather than guessing it.
 *
 * The answer is an argv to *read*, not one this codebase runs: `reset --soft` and `branch <name>
 * <sha>` are not operations the product has, and a person who wants them can copy the line into a
 * terminal, which is what the activity card is for. `null` means there is nothing to undo with —
 * either the operation destroyed work nothing git knows can bring back, or its reverse is a decision
 * (a force push) rather than a command.
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

const backTo = (rev: string | null, mode: 'soft' | 'hard'): readonly string[] | null =>
  rev === null ? null : ['reset', `--${mode}`, rev];

export function reverseOf(cmd: GitCommand, before: BeforeState): readonly string[] | null {
  switch (cmd.op) {
    // The index and the working tree, which are two questions rather than one: staging is undone by
    // restoring the index, and unstaging by adding again.
    case 'add':
      return ['restore', '--staged', '--', ...cmd.paths];
    case 'unstage':
      return ['add', '--', ...cmd.paths];

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
      return ['branch', '-d', cmd.name];
    case 'branch-rename':
      return ['branch', '-m', cmd.to, cmd.name];
    case 'branch-delete': {
      const at = before.targets[cmd.name];
      // Without the sha the branch pointed at there is nothing to recreate it from, and a `-d` here
      // would be a command about a branch that does not exist — worse than saying so.
      return at === undefined ? null : ['branch', cmd.name, at];
    }

    case 'tag-create':
      return ['tag', '-d', cmd.name];
    case 'tag-delete': {
      const at = before.targets[cmd.name];
      return at === undefined ? null : ['tag', cmd.name, at];
    }

    case 'checkout':
      if (before.branch !== null) return ['switch', before.branch];
      return before.head === null ? null : ['switch', '--detach', before.head];

    // A stash that was pushed can be popped; one that was popped can be pushed again, though that
    // is a new entry with a new sha, which is why the line is worth reading before it is copied.
    case 'stash-push':
      return ['stash', 'pop'];
    case 'stash-pop':
      return ['stash', 'push'];

    // A conflict is resolvable backwards: the index stages are still there until the path is added,
    // so `checkout -m` regenerates the markers from them.
    case 'take-side':
    case 'resolve-conflict':
      return ['checkout', '-m', '--', ...(cmd.op === 'take-side' ? cmd.paths : [cmd.path])];

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
      return null;
  }
}
