import type { PendingRef } from './git/command.ts';
import { type GitCommand, InvalidArgumentError } from './git/command.ts';
import { parseCommitCount } from './git/count.ts';
import { type DiffFile, parseDiff } from './git/diff.ts';
import { type ExecuteOptions, execute, executeOrThrow, type GitResult } from './git/exec.ts';
import {
  type Commit,
  type CommitDetail,
  parseCommitDetail,
  parseLog,
  parseRefs,
  type Ref,
} from './git/log.ts';
import { parseStashList, type StashEntry } from './git/stash.ts';
import {
  PENDING_ORDER,
  type PendingOperation,
  parsePendingOperation,
  parseStatus,
  type RepoState,
} from './git/status.ts';
import { type GraphLayout, layoutGraph, refsByOid } from './graph/layout.ts';
import { type WorkingTreeNode, workingTreeNode } from './graph/wip.ts';

export class NotARepositoryError extends Error {
  override readonly name = 'NotARepositoryError';
  readonly path: string;
  constructor(path: string) {
    super(`${path} is not inside a git working tree`);
    this.path = path;
  }
}

export class RepositoryParseError extends Error {
  override readonly name = 'RepositoryParseError';
  readonly what: string;
  readonly detail: string;
  readonly record: string;
  constructor(what: string, detail: string, record: string) {
    super(`could not read ${what}: ${detail}`);
    this.what = what;
    this.detail = detail;
    this.record = record;
  }
}

export interface RepoHandle {
  /** Absolute path to the working tree root, as git reports it. */
  readonly root: string;
}

export interface GraphData {
  readonly commits: readonly Commit[];
  readonly layout: GraphLayout;
  readonly refs: readonly Ref[];
  readonly refsByOid: ReturnType<typeof refsByOid>;
  /** How many commits the same history holds, whether or not the window shows them all. */
  readonly total: number;
  /** `commits.length < total`: the window cut the history, and that must be visible. */
  readonly truncated: boolean;
  /**
   * The working tree, which is the row above the first commit rather than a row of the layout.
   * Read here as well, and not only by the status call the window already makes, so that a
   * `graph` read answers the whole question on its own.
   */
  readonly wip: WorkingTreeNode;
  /**
   * The stashes the reading holds, newest first, and empty when the reading is of one revision.
   *
   * A stash is not a branch and has no ref of its own beyond `refs/stash`, so without this a
   * renderer cannot tell a stash row from an ordinary commit: the subject says `WIP on main: …`
   * and every other field is a commit's.
   */
  readonly stashes: readonly StashEntry[];
}

/**
 * The API both front-ends call. The desktop app and the CLI are two ways of asking these
 * same questions — neither of them contains its own copy of a git invocation, which is
 * the only way the two can be guaranteed to agree.
 */
export async function openRepo(
  path: string,
  options: Partial<ExecuteOptions> = {},
): Promise<RepoHandle> {
  const result = await execute({ op: 'repo-root' }, { cwd: path, ...options });
  if (result.exitCode !== 0) throw new NotARepositoryError(path);
  const root = result.stdout.trim();
  if (root === '') throw new NotARepositoryError(path);
  return { root };
}

/**
 * The operation git is in the middle of, if any.
 *
 * Three spawns, not one: `rev-parse -q --verify A B C` exits 1 as soon as one name is missing,
 * which loses the other two answers. `readStatus` asks this alongside the status read, so the
 * two cannot disagree about which repository they describe.
 */
export async function readPendingOperation(
  repo: RepoHandle,
  options: Partial<ExecuteOptions> = {},
): Promise<PendingOperation | null> {
  const results = await Promise.all(
    PENDING_ORDER.map(({ ref }) =>
      execute({ op: 'pending-operation', ref }, { cwd: repo.root, ...options }),
    ),
  );
  const reads: Partial<Record<PendingRef, string>> = {};
  for (let index = 0; index < PENDING_ORDER.length; index += 1) {
    const probe = PENDING_ORDER[index];
    if (probe !== undefined) reads[probe.ref] = results[index]?.stdout ?? '';
  }
  return parsePendingOperation(reads);
}

export async function readStatus(
  repo: RepoHandle,
  options: Partial<ExecuteOptions> = {},
): Promise<RepoState> {
  // The pending operation is read in parallel with the status: an unmerged entry says a file
  // is conflicted, and only these refs say which command has to be finished or aborted.
  const [statusResult, pending] = await Promise.all([
    executeOrThrow({ op: 'status' }, { cwd: repo.root, ...options }),
    readPendingOperation(repo, options),
  ]);
  const parsed = parseStatus(statusResult.stdout);
  if (!parsed.ok)
    throw new RepositoryParseError('the repository status', parsed.error, parsed.record);
  return { ...parsed.value, pending };
}

/**
 * The working tree as a node of the graph, for a caller that has no status in hand.
 *
 * One spawn, and deliberately not `readStatus`: the node counts entries and asks HEAD for its
 * oid, and the three `rev-parse --verify` probes that name a pending merge would be paid for and
 * thrown away.
 */
export async function readWorkingTreeNode(
  repo: RepoHandle,
  options: Partial<ExecuteOptions> = {},
): Promise<WorkingTreeNode> {
  const { stdout } = await executeOrThrow({ op: 'status' }, { cwd: repo.root, ...options });
  const parsed = parseStatus(stdout);
  if (!parsed.ok)
    throw new RepositoryParseError('the repository status', parsed.error, parsed.record);
  return workingTreeNode(parsed.value);
}

export async function readRefs(
  repo: RepoHandle,
  options: Partial<ExecuteOptions> = {},
): Promise<readonly Ref[]> {
  const { stdout } = await executeOrThrow({ op: 'refs' }, { cwd: repo.root, ...options });
  const parsed = parseRefs(stdout);
  if (!parsed.ok) throw new RepositoryParseError('the refs', parsed.error, parsed.record);
  return parsed.value;
}

/**
 * The stashes this repository holds, newest first.
 *
 * An empty list is the answer for a repository with nothing stashed, exactly as it is for a
 * repository with no commits yet: `git stash list` reads a log that is not there yet.
 */
export async function readStash(
  repo: RepoHandle,
  options: Partial<ExecuteOptions> = {},
): Promise<readonly StashEntry[]> {
  const { stdout } = await executeOrThrow({ op: 'stash-list' }, { cwd: repo.root, ...options });
  const parsed = parseStashList(stdout);
  if (!parsed.ok) throw new RepositoryParseError('the stash list', parsed.error, parsed.record);
  return parsed.value;
}

/**
 * One stash's own patch: the stash against the commit it was taken from.
 *
 * The same shape as any other diff, which is the point — the pane that draws a commit's patch and
 * the pane that draws a working-tree change draw this one too, and a preview that was its own
 * rendering would be a second opinion about what a stash holds.
 */
export async function readStashPatch(
  repo: RepoHandle,
  request: { readonly selector: string },
  options: Partial<ExecuteOptions> = {},
): Promise<readonly DiffFile[]> {
  const { stdout } = await executeOrThrow(
    { op: 'stash-show', selector: request.selector },
    { cwd: repo.root, ...options },
  );
  const parsed = parseDiff(stdout);
  if (!parsed.ok) throw new RepositoryParseError('the stash patch', parsed.error, parsed.record);
  return parsed.value;
}

export async function readDiff(
  repo: RepoHandle,
  request: { rev?: string; cached?: boolean; path?: string } = { rev: 'HEAD' },
  options: Partial<ExecuteOptions> = {},
): Promise<readonly DiffFile[]> {
  const { stdout } = await executeOrThrow(
    {
      op: 'diff',
      // No revision and not cached is the working tree against the index; an omitted `rev`
      // is a question, not an oversight, so it is only sent when the caller named one.
      ...(request.rev === undefined ? {} : { rev: request.rev }),
      ...(request.cached === true ? { cached: true } : {}),
      ...(request.path === undefined ? {} : { path: request.path }),
    },
    { cwd: repo.root, ...options },
  );
  const parsed = parseDiff(stdout);
  if (!parsed.ok) throw new RepositoryParseError('the diff', parsed.error, parsed.record);
  return parsed.value;
}

/** What the patch in a `CommitData` is measured against, derived from the commit itself. */
export type CommitAgainst = 'root' | 'parent' | 'first-parent';

export interface CommitData {
  readonly commit: CommitDetail;
  readonly files: readonly DiffFile[];
  readonly against: CommitAgainst;
}

export async function readCommit(
  repo: RepoHandle,
  request: { rev: string },
  options: Partial<ExecuteOptions> = {},
): Promise<CommitData> {
  const [detail, patch] = await Promise.all([
    executeOrThrow({ op: 'commit-detail', rev: request.rev }, { cwd: repo.root, ...options }),
    executeOrThrow({ op: 'commit-patch', rev: request.rev }, { cwd: repo.root, ...options }),
  ]);
  const parsedDetail = parseCommitDetail(detail.stdout);
  if (!parsedDetail.ok) {
    throw new RepositoryParseError('the commit', parsedDetail.error, parsedDetail.record);
  }
  const parsedPatch = parseDiff(patch.stdout);
  if (!parsedPatch.ok) {
    throw new RepositoryParseError('the commit patch', parsedPatch.error, parsedPatch.record);
  }
  return {
    commit: parsedDetail.value,
    files: parsedPatch.value,
    // Never a caller's guess: how many parents the commit has decides how its patch reads.
    against: againstParents(parsedDetail.value.parents.length),
  };
}

function againstParents(parentCount: number): CommitAgainst {
  if (parentCount === 0) return 'root';
  if (parentCount === 1) return 'parent';
  return 'first-parent';
}

export interface GraphRequest {
  readonly limit?: number;
  readonly all?: boolean;
  readonly rev?: string;
}

export async function readGraph(
  repo: RepoHandle,
  request: GraphRequest = {},
  options: Partial<ExecuteOptions> = {},
): Promise<GraphData> {
  const limit = request.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new InvalidArgumentError(`limit must be a positive integer, got ${limit}`);
  }
  // A stash older than the newest is reachable from nothing but the reflog of `refs/stash`, so
  // `--all` does not reach it and the only way to draw it is to name it. Read first, because the
  // log and the count have to name the *same* revisions: a total from a narrower history would
  // make `truncated` and the header compare two different pictures.
  const stashes = request.all === true ? await readStash(repo, options) : [];
  const also = stashes.length === 0 ? {} : { also: stashes.map((stash) => stash.oid) };
  const [log, refs, count, wip] = await Promise.all([
    executeOrThrow(
      {
        op: 'graph',
        limit,
        ...(request.all === true ? { all: true } : {}),
        ...(request.rev === undefined ? {} : { rev: request.rev }),
        ...also,
      },
      { cwd: repo.root, ...options },
    ),
    readRefs(repo, options),
    // The same `all` and `rev` as the log: a total from a different history would make
    // `truncated` compare two different repositories.
    executeOrThrow(
      {
        op: 'count',
        ...(request.all === true ? { all: true } : {}),
        ...(request.rev === undefined ? {} : { rev: request.rev }),
        ...also,
      },
      { cwd: repo.root, ...options },
    ),
    readWorkingTreeNode(repo, options),
  ]);
  const parsed = parseLog(log.stdout);
  if (!parsed.ok) throw new RepositoryParseError('the commit log', parsed.error, parsed.record);
  const parsedCount = parseCommitCount(count.stdout);
  if (!parsedCount.ok) {
    throw new RepositoryParseError('the commit count', parsedCount.error, parsedCount.record);
  }
  return {
    commits: parsed.value,
    layout: layoutGraph(parsed.value),
    refs,
    // `refs/stash` names only the newest entry and says less than its selector does, so when the
    // stashes are in the reading the badge comes from the entry and not from the ref. The list
    // itself stays whole: it is what the ref filter and `orbitree refs` are made of.
    refsByOid: refsByOid(
      stashes.length === 0 ? refs : refs.filter((ref) => ref.name !== 'refs/stash'),
    ),
    total: parsedCount.value,
    truncated: parsed.value.length < parsedCount.value,
    wip,
    stashes,
  };
}

/**
 * The escape hatch for operations the typed union does not have yet. It still goes
 * through the executor, so confirmation, timeouts, redaction and `shell: false` apply.
 */
export async function run(cmd: GitCommand, options: ExecuteOptions): Promise<GitResult> {
  return execute(cmd, options);
}
