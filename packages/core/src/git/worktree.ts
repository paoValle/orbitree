/**
 * Parser for `git worktree list --porcelain`.
 *
 * The same two rules as every other parser in `git/`: it never throws — a block it cannot
 * understand is a value — and it never drops a record, because every worktree keeps the text git
 * printed for it.
 *
 * The format is a block per worktree, each a set of `key value` lines, with a blank line between
 * blocks. The keys are git's: `worktree`, `HEAD`, `branch` (absent when the worktree is detached or
 * bare), and the flags `bare`, `detached`, `locked`, `prunable` stand alone or carry a reason.
 */
import type { ParseResult } from './status.ts';

export interface Worktree {
  /** The absolute path of the working directory. */
  readonly path: string;
  /** The commit that worktree has checked out. */
  readonly head: string | null;
  /** The branch it is on, or `null` when it is detached or bare. */
  readonly branch: string | null;
  readonly bare: boolean;
  readonly detached: boolean;
  /** Why it is locked, or `null`. A locked worktree is one somebody is protecting on purpose. */
  readonly locked: string | null;
  /** Why git would prune it, or `null`. */
  readonly prunable: string | null;
  /** The block exactly as git printed it. */
  readonly raw: string;
}

const HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export function parseWorktrees(stdout: string): ParseResult<readonly Worktree[]> {
  const blocks = stdout.split('\n\n').filter((block) => block.trim() !== '');
  const worktrees: Worktree[] = [];
  for (const block of blocks) {
    const parsed = parseBlock(block);
    if (!parsed.ok) return parsed;
    worktrees.push(parsed.value);
  }
  return { ok: true, value: worktrees };
}

function parseBlock(block: string): ParseResult<Worktree> {
  const raw = block.endsWith('\n') ? block : `${block}\n`;
  let path: string | null = null;
  let head: string | null = null;
  let branch: string | null = null;
  let bare = false;
  let detached = false;
  let locked: string | null = null;
  let prunable: string | null = null;

  for (const line of block.split('\n')) {
    if (line.trim() === '') continue;
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1);
    switch (key) {
      case 'worktree':
        path = value;
        break;
      case 'HEAD':
        head = value;
        break;
      case 'branch':
        // `refs/heads/x` is a branch; anything else is a commit-ish this version does not know, and
        // keeping it as the branch is better than dropping it: it is what git printed.
        branch = value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value;
        break;
      case 'bare':
        bare = true;
        break;
      case 'detached':
        detached = true;
        break;
      case 'locked':
        locked = value === '' ? 'locked' : value;
        break;
      case 'prunable':
        prunable = value === '' ? 'prunable' : value;
        break;
      default:
        // A key this version does not know is data rather than a failure: the block is kept whole.
        break;
    }
  }

  if (path === null) {
    return { ok: false, error: 'a worktree block has no `worktree` line', record: block };
  }
  if (head !== null && !HASH.test(head)) {
    return { ok: false, error: 'a worktree HEAD is not a commit hash', record: block };
  }
  return { ok: true, value: { path, head, branch, bare, detached, locked, prunable, raw } };
}
