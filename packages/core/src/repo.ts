import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PendingRef } from './git/command.ts';
import { type GitCommand, InvalidArgumentError } from './git/command.ts';
import { type BlameLine, parseBlame } from './git/blame.ts';
import { type Comparison, parseComparison } from './git/compare.ts';
import { parseCommitCount } from './git/count.ts';
import { type ConflictRegion, linesOf, parseConflictRegions } from './git/conflict.ts';
import { visibleCommits } from './graph/visible.ts';
import { type DiffFile, parseDiff } from './git/diff.ts';
import {
  type ExecuteOptions,
  execute,
  executeOrThrow,
  GitFailedError,
  type GitResult,
} from './git/exec.ts';
import {
  type Commit,
  type CommitDetail,
  parseCommitDetail,
  parseLog,
  parseRefs,
  type Ref,
} from './git/log.ts';
import { parseStashList, type StashEntry } from './git/stash.ts';
import { parseRemotes, type Remote } from './git/remote.ts';
import { type Identity, parseIdentity } from './git/identity.ts';
import { type Credential, type CredentialRequest, parseCredential } from './git/credential.ts';
import { parseWorktrees, type Worktree } from './git/worktree.ts';
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
  /**
   * The names the picture is not drawing, in the order they were hidden.
   *
   * The commits, the layout and the count are all about the history that was read; this is the one
   * field that says the picture is a *subset* of it, so a header can say so rather than showing a
   * count that quietly disagrees with the rows.
   */
  readonly hidden: readonly string[];
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
 * A file in the working tree, as text.
 *
 * git cannot answer this: the working tree is not an object, and a conflicted file's text — markers
 * and all — exists nowhere else. One read, shared by the region list and the resolver, so the two
 * cannot disagree about which file they are describing.
 */
export async function readWorkingFile(
  repo: RepoHandle,
  request: { readonly path: string },
): Promise<string> {
  return readFile(join(repo.root, request.path), 'utf8');
}

/**
 * The conflict regions of one path, counted from 0 in the order the markers appear.
 *
 * The same parse the resolver uses, so a caller choosing region 2 is choosing the region the
 * resolver will replace: two implementations of "which region is this" is one too many.
 */
export async function readConflictRegions(
  repo: RepoHandle,
  request: { readonly path: string },
): Promise<readonly ConflictRegion[]> {
  return parseConflictRegions(linesOf(await readWorkingFile(repo, request)));
}

/**
 * One of the three versions of a conflicted path: what the two branches had in common, what this
 * branch has, and what the other one has.
 *
 * The three live in the index as stages 1, 2 and 3 for as long as the conflict is unresolved, which
 * is why the screen can show all of them without touching a merge in progress.
 */
export async function readConflictSide(
  repo: RepoHandle,
  request: { readonly path: string; readonly side: 'base' | 'ours' | 'theirs' },
  options: Partial<ExecuteOptions> = {},
): Promise<string> {
  const { stdout } = await executeOrThrow(
    { op: 'conflict-side', side: request.side, path: request.path },
    { cwd: repo.root, ...options },
  );
  return stdout;
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

/**
 * Every working directory this repository has checked out.
 *
 * A worktree is a second working copy of one history: the same repository, another directory, its own
 * index. The list always holds the one the read happened in, which is what makes it useful — it is
 * the answer to "where else is this repository on this disk".
 */
export async function readWorktrees(
  repo: RepoHandle,
  options: Partial<ExecuteOptions> = {},
): Promise<readonly Worktree[]> {
  const { stdout } = await executeOrThrow({ op: 'worktree-list' }, { cwd: repo.root, ...options });
  const parsed = parseWorktrees(stdout);
  if (!parsed.ok) throw new RepositoryParseError('the worktree list', parsed.error, parsed.record);
  return parsed.value;
}

/**
 * The remotes this repository is configured with, and what each one is for.
 *
 * Read from the config, not from the network: a remote is a name and two URLs on this disk, and
 * whether the machine at the other end answers is a different question — one for `fetch` to ask.
 */
export async function readRemotes(
  repo: RepoHandle,
  options: Partial<ExecuteOptions> = {},
): Promise<readonly Remote[]> {
  const { stdout } = await executeOrThrow({ op: 'remote-list' }, { cwd: repo.root, ...options });
  const parsed = parseRemotes(stdout);
  if (!parsed.ok) throw new RepositoryParseError('the remote list', parsed.error, parsed.record);
  return parsed.value;
}

/**
 * Whether a credential is stored for a host, asked of git's own helper.
 *
 * A failure to *find* one is not a failure of the read: "nothing is stored" is the answer to the
 * question, and git says so by exiting non-zero and printing why — which is kept as a note rather than
 * thrown, because the message is the useful half ("terminal prompts disabled", a helper that is
 * misconfigured, a keychain that is locked).
 */
export async function readCredential(
  repo: RepoHandle,
  request: CredentialRequest,
  options: Partial<ExecuteOptions> = {},
): Promise<CredentialAnswer> {
  const result = await execute({ op: 'credential-fill', request }, { cwd: repo.root, ...options });
  if (result.exitCode !== 0) {
    return {
      available: false,
      username: null,
      hasPassword: false,
      entries: [],
      note: result.stderr.trim().split('\n')[0] ?? '',
    };
  }
  const parsed = parseCredential(result.stdout);
  if (!parsed.ok) {
    throw new RepositoryParseError('the credential', parsed.error, parsed.record);
  }
  return { ...parsed.value, note: null };
}

export interface CredentialAnswer {
  readonly available: boolean;
  readonly username: string | null;
  readonly hasPassword: boolean;
  /** Why there is none, in git's own words, or `null` when one was found. */
  readonly note: string | null;
  /** The `key=value` lines git printed, minus the password: the shape is kept, the secret is not. */
  readonly entries: Credential['entries'];
}

/**
 * The identity commits are made with, and where each part of it comes from.
 *
 * A repository nobody has configured a name in is not an error: `git config --get-regexp` exits 1
 * when nothing matches, which is the answer "nothing is set" rather than a failed read, and looking
 * at a repository is not something that requires an identity.
 */
export async function readIdentity(
  repo: RepoHandle,
  options: Partial<ExecuteOptions> = {},
): Promise<Identity> {
  const result = await execute({ op: 'identity' }, { cwd: repo.root, ...options });
  if (result.exitCode !== 0) {
    const nothingMatched = result.exitCode === 1 && result.stderr.trim() === '';
    if (!nothingMatched) {
      throw new GitFailedError(result.argv, result.exitCode, result.stderr);
    }
  }
  const parsed = parseIdentity(result.stdout);
  if (!parsed.ok) throw new RepositoryParseError('the identity', parsed.error, parsed.record);
  return parsed.value;
}

/**
 * What each side of a fork has that the other does not.
 *
 * One read of `--left-right --cherry-pick A...B`, which is also the reason this is not a set difference
 * of two log reads: `--cherry-pick` leaves out the commits whose patch is already on the other side, so
 * two branches that were rebased or cherry-picked onto each other are reported as agreeing about the
 * work rather than disagreeing about the history.
 */
export async function readComparison(
  repo: RepoHandle,
  request: { readonly left: string; readonly right: string; readonly limit?: number },
  options: Partial<ExecuteOptions> = {},
): Promise<Comparison> {
  const { stdout } = await executeOrThrow(
    {
      op: 'compare',
      left: request.left,
      right: request.right,
      limit: request.limit ?? 500,
    },
    { cwd: repo.root, ...options },
  );
  const parsed = parseComparison(stdout);
  if (!parsed.ok) {
    throw new RepositoryParseError('the comparison', parsed.error, parsed.record);
  }
  const onlyLeft: Commit[] = [];
  const onlyRight: Commit[] = [];
  for (const marked of parsed.value) {
    if (marked.side === 'left') onlyLeft.push(marked.commit);
    if (marked.side === 'right') onlyRight.push(marked.commit);
  }
  return {
    left: request.left,
    right: request.right,
    onlyLeft,
    onlyRight,
    records: parsed.value,
  };
}

/**
 * Who wrote each line of one file, and in which commit.
 *
 * A read of the file *as it is* unless a revision is named: blame answers "where did this line come
 * from", so the numbering is the numbering of the file on screen unless a caller asked about an older
 * one.
 */
export async function readBlame(
  repo: RepoHandle,
  request: { readonly path: string; readonly rev?: string },
  options: Partial<ExecuteOptions> = {},
): Promise<readonly BlameLine[]> {
  const { stdout } = await executeOrThrow(
    {
      op: 'blame',
      path: request.path,
      ...(request.rev === undefined ? {} : { rev: request.rev }),
    },
    { cwd: repo.root, ...options },
  );
  const parsed = parseBlame(stdout);
  if (!parsed.ok) throw new RepositoryParseError('the blame', parsed.error, parsed.record);
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
  /** Names whose exclusive commits are left out of the picture. Nothing is written. */
  readonly hide?: readonly string[];
  /**
   * One path, for the history of one file.
   *
   * The commits git says touched it, drawn by the same `layoutGraph` as any other picture: a file's
   * history is the same shape of question as the repository's, which is why this is a field and not a
   * second read that would drift from the first.
   */
  readonly path?: string;
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
        ...(request.path === undefined ? {} : { path: request.path }),
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
        ...(request.path === undefined ? {} : { path: request.path }),
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
  // Reachability from the names that are not hidden, which is the whole of hiding: the commits kept
  // are the ones some visible name can still reach, and the layout is laid over those, so the shape
  // of what is drawn is the shape of what is there.
  const hidden = request.hide ?? [];
  const kept =
    hidden.length === 0
      ? parsed.value
      : visibleCommits(parsed.value, [
          ...refs.filter((ref) => !hidden.includes(ref.shortName)).map((ref) => ref.target),
          ...(wip.on === null ? [] : [wip.on]),
        ]);
  return {
    commits: kept,
    layout: layoutGraph(kept),
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
    hidden,
  };
}

/**
 * The escape hatch for operations the typed union does not have yet. It still goes
 * through the executor, so confirmation, timeouts, redaction and `shell: false` apply.
 */
export async function run(cmd: GitCommand, options: ExecuteOptions): Promise<GitResult> {
  return execute(cmd, options);
}
