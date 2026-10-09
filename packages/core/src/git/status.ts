/**
 * Parser for `git status --porcelain=v2 --branch -z`.
 *
 * Two rules hold for every parser in this file and in `log.ts`:
 *   1. it never throws — a broken record is a value (`ParseResult`), because a UI that
 *      crashes on a repository state it has not seen yet is worse than one that says why;
 *   2. it never silently drops a record — every entry keeps the raw line it came from.
 */
import type { PendingRef } from './command.ts';

export type { PendingRef };

export type FileStatus =
  | 'unmodified'
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange'
  | 'unmerged'
  | 'untracked'
  | 'ignored'
  | 'unknown';

const BY_CODE: Readonly<Record<string, FileStatus>> = {
  '.': 'unmodified',
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
  U: 'unmerged',
  '?': 'untracked',
  '!': 'ignored',
};

export function fileStatus(code: string): FileStatus {
  return BY_CODE[code] ?? 'unknown';
}

/**
 * The submodule field of a porcelain v2 entry: the third field of an ordinary, renamed or
 * unmerged record. `N...` means an ordinary file; `S<c><m><u>` means a submodule whose own
 * commit is conflicted (`c`), modified (`m`) or has untracked content (`u`).
 *
 * Recognised by the `S`, not by the three characters after it: those are git's to define, and
 * a state this version does not know yet has to arrive as data rather than as `null`.
 */
function submoduleState(field: string): string | null {
  return field.startsWith('S') ? field : null;
}

/** A record whose XY pair means "this path is in a conflicted merge". */
export interface UnmergedEntry {
  readonly kind: 'unmerged';
  readonly path: string;
  readonly index: FileStatus;
  readonly worktree: FileStatus;
  /** The submodule state git printed (`S<c><m><u>`), or `null` for a normal file. */
  readonly submodule: string | null;
  readonly raw: string;
}

export interface ChangedEntry {
  readonly kind: 'ordinary' | 'renamed';
  readonly path: string;
  readonly index: FileStatus;
  readonly worktree: FileStatus;
  /** Only for `renamed`/`copied`: where the file came from. */
  readonly origPath?: string;
  /** The submodule state git printed (`S<c><m><u>`), or `null` for a normal file. */
  readonly submodule: string | null;
  readonly raw: string;
}

export interface UntrackedEntry {
  readonly kind: 'untracked';
  readonly path: string;
  /** Always `null`: an untracked record carries no submodule field at all. */
  readonly submodule: string | null;
  readonly raw: string;
}

export interface IgnoredEntry {
  readonly kind: 'ignored';
  readonly path: string;
  /** Always `null`: an ignored record carries no submodule field at all. */
  readonly submodule: string | null;
  readonly raw: string;
}

export type StatusEntry = ChangedEntry | UnmergedEntry | UntrackedEntry | IgnoredEntry;

export type Head =
  | {
      readonly kind: 'branch';
      readonly name: string;
      readonly oid: string;
      readonly upstream: string | null;
      readonly ahead: number;
      readonly behind: number;
    }
  | { readonly kind: 'detached'; readonly oid: string }
  /** A repository with no commits yet: `HEAD` points at a branch that does not exist. */
  | { readonly kind: 'unborn'; readonly name: string | null };

/**
 * The operation git is in the middle of. A repository in this state is not broken: it is
 * stopped halfway, and the refs below are what git itself reads to say so.
 */
export type PendingOperation = 'merge' | 'cherry-pick' | 'rebase';

export const PENDING_OPERATIONS: readonly PendingOperation[] = ['merge', 'cherry-pick', 'rebase'];

/**
 * Which ref means which operation, and the order the three are asked in: the first one that
 * resolves wins. A rebase leaves a `MERGE_HEAD` behind, so the order is not interchangeable.
 */
export const PENDING_ORDER: readonly {
  readonly ref: PendingRef;
  readonly operation: PendingOperation;
}[] = [
  { ref: 'MERGE_HEAD', operation: 'merge' },
  { ref: 'CHERRY_PICK_HEAD', operation: 'cherry-pick' },
  { ref: 'REBASE_HEAD', operation: 'rebase' },
];

export interface RepoState {
  readonly head: Head;
  readonly entries: readonly StatusEntry[];
  /** Header lines we did not model, kept so that nothing is invented and nothing is lost. */
  readonly headers: Readonly<Record<string, string>>;
  /** The operation under way, or `null` when the repository is merely sitting there. */
  readonly pending: PendingOperation | null;
}

/**
 * Maps the three `rev-parse --verify` outputs onto one state.
 *
 * Total by construction: a read is data, not an exit code, so an empty output is simply
 * "git has no such ref" and a missing probe is "nobody asked". Neither throws, and nothing
 * here re-derives the command — `PENDING_ORDER` and `toArgv` own that.
 */
export function parsePendingOperation(
  reads: Readonly<Partial<Record<PendingRef, string>>>,
): PendingOperation | null {
  for (const { ref, operation } of PENDING_ORDER) {
    if ((reads[ref] ?? '').trim() !== '') return operation;
  }
  return null;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string; readonly record: string };

export function parseStatus(stdout: string): ParseResult<RepoState> {
  const records = splitNul(stdout);
  const headers: Record<string, string> = {};
  const entries: StatusEntry[] = [];
  let oid: string | null = null;
  let branchName: string | null = null;
  let detached = false;
  let unborn = false;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record === undefined) break;

    if (record.startsWith('# ')) {
      const rest = record.slice(2);
      const space = rest.indexOf(' ');
      const key = space === -1 ? rest : rest.slice(0, space);
      const value = space === -1 ? '' : rest.slice(space + 1);
      headers[key] = value;
      switch (key) {
        case 'branch.oid':
          if (value === '(initial)') unborn = true;
          else oid = value;
          break;
        case 'branch.head':
          if (value === '(detached)') detached = true;
          else branchName = value;
          break;
        case 'branch.upstream':
          upstream = value === '' ? null : value;
          break;
        case 'branch.ab': {
          const match = /^\+(\d+) -(\d+)$/.exec(value);
          if (match === null) {
            return { ok: false, error: 'branch.ab is not "+<ahead> -<behind>"', record };
          }
          ahead = Number.parseInt(match[1] as string, 10);
          behind = Number.parseInt(match[2] as string, 10);
          break;
        }
        default:
          // An unknown header is kept in `headers` and cannot break the parse.
          break;
      }
      continue;
    }

    const kind = record[0];
    if (kind === undefined) return { ok: false, error: 'empty record', record };

    if (kind === '?') {
      entries.push({ kind: 'untracked', path: record.slice(2), submodule: null, raw: record });
      continue;
    }
    if (kind === '!') {
      entries.push({ kind: 'ignored', path: record.slice(2), submodule: null, raw: record });
      continue;
    }

    const parts = record.split(' ');
    const xy = parts[1];
    if (xy === undefined || xy.length !== 2) {
      return { ok: false, error: 'missing XY status pair', record };
    }
    // The submodule field is third, whatever the record type is. It is the one field a
    // parser that only looks at the path can lose, so it is read before the switch.
    const submodule = submoduleState(parts[2] ?? '');
    const index = fileStatus(xy[0] as string);
    const worktree = fileStatus(xy[1] as string);

    switch (kind) {
      case '1': {
        const path = pathFrom(parts, 8);
        if (path === null) return { ok: false, error: 'ordinary entry has no path', record };
        entries.push({ kind: 'ordinary', path, index, worktree, submodule, raw: record });
        break;
      }
      case '2': {
        const path = pathFrom(parts, 9);
        if (path === null) return { ok: false, error: 'rename entry has no path', record };
        // In `-z` mode the original path is the next NUL-terminated record, never quoted.
        const origPath = records[i + 1];
        if (origPath === undefined) {
          return { ok: false, error: 'rename entry has no original path', record };
        }
        i += 1;
        entries.push({ kind: 'renamed', path, origPath, index, worktree, submodule, raw: record });
        break;
      }
      case 'u': {
        const path = pathFrom(parts, 10);
        if (path === null) return { ok: false, error: 'unmerged entry has no path', record };
        entries.push({ kind: 'unmerged', path, index, worktree, submodule, raw: record });
        break;
      }
      default:
        return { ok: false, error: `unknown record type "${kind}"`, record };
    }
  }

  const head: Head = unborn
    ? { kind: 'unborn', name: branchName }
    : detached || branchName === null
      ? { kind: 'detached', oid: oid ?? '' }
      : { kind: 'branch', name: branchName, oid: oid ?? '', upstream, ahead, behind };

  // `pending` is a separate read, not a status record: `readStatus` asks git for the three
  // refs and overwrites this. A caller using `parseStatus` on its own is told "nothing under
  // way", which is the only answer the porcelain output can give.
  return { ok: true, value: { head, entries, headers, pending: null } };
}

function splitNul(stdout: string): string[] {
  const records = stdout.split('\u0000');
  // `-z` terminates every record, so the input ends with a separator and one empty tail.
  if (records[records.length - 1] === '') records.pop();
  return records;
}

/** Paths may contain spaces; only the first `index` fields are fixed-width. */
function pathFrom(parts: readonly string[], index: number): string | null {
  if (parts.length <= index) return null;
  const path = parts.slice(index).join(' ');
  return path === '' ? null : path;
}
