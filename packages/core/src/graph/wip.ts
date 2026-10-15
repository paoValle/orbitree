import type { RepoState } from '../git/status.ts';

/**
 * The working tree as a place in the graph.
 *
 * Not a row in the layout: `layoutGraph` is a pure function of the DAG (invariant I6), and this
 * is not a commit but the absence of one. It is a fact *beside* the rows — a node above the
 * first commit, joined to the commit HEAD sits on — which is the argument this product already
 * makes for a detached head: what is not committed yet is still a place in the picture.
 *
 * The four counts are the four sections the working-tree card draws, read from the same status,
 * so the node and the card cannot disagree about how much is waiting.
 */
export interface WorkingTreeNode {
  /** The commit the working tree sits on, or `null` in a repository with no commits yet. */
  readonly on: string | null;
  readonly staged: number;
  readonly unstaged: number;
  readonly conflicted: number;
  readonly untracked: number;
  /** Whether any count above is non-zero. A clean tree is still a node, and says so. */
  readonly dirty: boolean;
}

/**
 * The counts follow the working-tree card's own sections, including its one deliberate choice:
 * an unmerged entry is a conflict rather than a staged and an unstaged change at once, so it is
 * counted once, under `conflicted`, and never also under `staged`.
 */
export function workingTreeNode(state: Pick<RepoState, 'head' | 'entries'>): WorkingTreeNode {
  let staged = 0;
  let unstaged = 0;
  let conflicted = 0;
  let untracked = 0;
  for (const entry of state.entries) {
    switch (entry.kind) {
      case 'ordinary':
      case 'renamed':
        if (entry.index !== 'unmodified') staged += 1;
        if (entry.worktree !== 'unmodified') unstaged += 1;
        break;
      case 'unmerged':
        conflicted += 1;
        break;
      case 'untracked':
        untracked += 1;
        break;
      case 'ignored':
        break;
    }
  }
  return {
    on: state.head.kind === 'unborn' ? null : state.head.oid,
    staged,
    unstaged,
    conflicted,
    untracked,
    dirty: staged + unstaged + conflicted + untracked > 0,
  };
}
