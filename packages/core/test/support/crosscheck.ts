/**
 * The independent reading of a repository: `git`'s own plumbing and status v1.
 *
 * This is what keeps the status test honest. Comparing the v2 parser against v1 output
 * and against `rev-parse`/`symbolic-ref`/`ls-files` means the expectations do not come
 * from the code under test — if both halves of the product agreed with each other and
 * were both wrong, these still disagree.
 */

import type { RepoState } from '../../src/git/status.ts';
import { git } from './fixtures.ts';

export interface Mismatch {
  readonly what: string;
  readonly expected: string;
  readonly actual: string;
}

const show = (value: unknown): string =>
  typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value);

/** `git status --porcelain=v1 -z`, read here and nowhere else. */
async function v1Entries(root: string): Promise<Map<string, { x: string; y: string }>> {
  const { stdout } = await git(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all');
  const records = stdout.split('\u0000');
  if (records[records.length - 1] === '') records.pop();
  const entries = new Map<string, { x: string; y: string }>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as string;
    if (record === '') continue;
    const x = dot(record[0] as string);
    const y = dot(record[1] as string);
    const path = record.slice(3);
    if (x === 'R' || x === 'C') {
      // In -z mode v1 puts the target path in the next record: `R  <target>\0<source>`.
      index += 1;
      entries.set(path, { x, y });
      continue;
    }
    entries.set(path, { x, y });
  }
  return entries;
}

/** v1 writes "unmodified" as a space; v2 writes it as a dot. Same state, two alphabets. */
function dot(code: string): string {
  return code === ' ' ? '.' : code;
}

export async function findStatusMismatches(root: string, state: RepoState): Promise<Mismatch[]> {
  const mismatches: Mismatch[] = [];

  // --- the head, from plumbing rather than from the parser ---
  const headOid = await git(root, 'rev-parse', '--verify', 'HEAD');
  const branch = await git(root, 'symbolic-ref', '--quiet', '--short', 'HEAD');
  if (headOid.code === 0 && state.head.kind !== 'unborn') {
    if (state.head.oid !== headOid.stdout.trim()) {
      mismatches.push({
        what: 'head.oid',
        expected: show(headOid.stdout.trim()),
        actual: show(state.head.oid),
      });
    }
  }
  if (headOid.code !== 0 && state.head.kind !== 'unborn') {
    mismatches.push({ what: 'head.kind', expected: 'unborn', actual: show(state.head.kind) });
  }
  if (branch.code === 0) {
    // An unborn repository still has a symbolic HEAD, so the name must match there too.
    const name = branch.stdout.trim();
    const reported =
      state.head.kind === 'branch' || state.head.kind === 'unborn' ? state.head.name : null;
    if (reported !== name) {
      mismatches.push({ what: 'head.name', expected: show(name), actual: show(state.head) });
    }
  } else if (state.head.kind === 'branch') {
    mismatches.push({ what: 'head.kind', expected: 'detached', actual: show(state.head) });
  }

  // --- ahead/behind, from rev-list rather than from the header ---
  const counts = await git(root, 'rev-list', '--count', '--left-right', '@{upstream}...HEAD');
  if (state.head.kind === 'branch') {
    if (counts.code === 0) {
      const [behind, ahead] = counts.stdout.trim().split(/\s+/);
      if (state.head.ahead !== Number(ahead) || state.head.behind !== Number(behind)) {
        mismatches.push({
          what: 'head.ahead/behind',
          expected: show({ ahead, behind }),
          actual: show({ ahead: state.head.ahead, behind: state.head.behind }),
        });
      }
    } else if (state.head.ahead !== 0 || state.head.behind !== 0) {
      mismatches.push({
        what: 'head.ahead/behind',
        expected: show({ ahead: 0, behind: 0 }),
        actual: show({ ahead: state.head.ahead, behind: state.head.behind }),
      });
    }
  }

  // --- every path with its XY pair, from the v1 format ---
  const v1 = await v1Entries(root);
  const v2 = new Map<string, { x: string; y: string }>();
  for (const entry of state.entries) {
    if (entry.kind === 'ignored') continue;
    if (entry.kind === 'untracked') {
      v2.set(entry.path, { x: '?', y: '?' });
      continue;
    }
    v2.set(entry.path, { x: codeOf(entry.index), y: codeOf(entry.worktree) });
  }
  for (const [path, pair] of v1) {
    const other = v2.get(path);
    if (other === undefined) {
      mismatches.push({
        what: `missing entry for ${show(path)}`,
        expected: show(pair),
        actual: 'absent',
      });
      continue;
    }
    if (other.x !== pair.x || other.y !== pair.y) {
      mismatches.push({
        what: `status of ${show(path)}`,
        expected: `${pair.x}${pair.y}`,
        actual: `${other.x}${other.y}`,
      });
    }
  }
  for (const path of v2.keys()) {
    if (!v1.has(path)) {
      mismatches.push({
        what: `extra entry for ${show(path)}`,
        expected: 'absent',
        actual: 'present',
      });
    }
  }

  // --- untracked and unmerged, from the index plumbing ---
  const others = await git(root, 'ls-files', '--others', '--exclude-standard', '-z');
  const untracked = splitZ(others.stdout);
  const parsedUntracked = state.entries
    .filter((entry) => entry.kind === 'untracked')
    .map((e) => e.path);
  mismatches.push(...compareSets('untracked paths', untracked, parsedUntracked));

  const unmerged = await git(root, 'ls-files', '--unmerged', '-z');
  const conflictedPaths = new Set(
    unmerged.stdout
      .split('\u0000')
      .filter((line) => line !== '')
      .map((line) => line.slice(line.indexOf('\t') + 1)),
  );
  const parsedUnmerged = state.entries
    .filter((entry) => entry.kind === 'unmerged')
    .map((e) => e.path);
  mismatches.push(...compareSets('unmerged paths', [...conflictedPaths], parsedUnmerged));

  return mismatches;
}

function codeOf(status: string): string {
  switch (status) {
    case 'unmodified':
      return '.';
    case 'modified':
      return 'M';
    case 'added':
      return 'A';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'copied':
      return 'C';
    case 'typechange':
      return 'T';
    case 'unmerged':
      return 'U';
    default:
      return 'X';
  }
}

function splitZ(stdout: string): string[] {
  const parts = stdout.split('\u0000');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.filter((part) => part !== '');
}

function compareSets(
  what: string,
  expected: readonly string[],
  actual: readonly string[],
): Mismatch[] {
  const left = [...expected].sort();
  const right = [...actual].sort();
  if (left.length === right.length && left.every((value, index) => value === right[index]))
    return [];
  return [{ what, expected: show(left), actual: show(right) }];
}
