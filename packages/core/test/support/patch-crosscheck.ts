/**
 * Test support: the patch cross-checks both diff.test.ts and commit.test.ts turn to.
 *
 * These read git's own `--name-status` and `--numstat` output, a second answer to the same
 * question the patch parser answers, so a parser bug cannot confirm itself.
 */
import type { DiffFile } from '../../src/git/diff.ts';

export function splitNul(stdout: string): string[] {
  const records = stdout.split('\u0000');
  if (records[records.length - 1] === '') records.pop();
  return records;
}

/** The bytes of the way the parser names things, mapped onto git's single-letter codes. */
export const STATUS_BY_CODE: Readonly<Record<string, DiffFile['status']>> = {
  A: 'added',
  D: 'deleted',
  M: 'modified',
  R: 'renamed',
  C: 'copied',
  T: 'modified',
};

export function parseNameStatus(stdout: string): Map<string, DiffFile['status']> {
  const tokens = splitNul(stdout);
  const paths = new Map<string, DiffFile['status']>();
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i];
    i += 1;
    if (status === undefined) break;
    const code = status[0] ?? '';
    if (code === 'R' || code === 'C') {
      i += 1; // the old path
      const path = tokens[i];
      i += 1;
      if (path !== undefined) paths.set(path, code === 'R' ? 'renamed' : 'copied');
    } else {
      const path = tokens[i];
      i += 1;
      if (path !== undefined) paths.set(path, STATUS_BY_CODE[code] ?? 'modified');
    }
  }
  return paths;
}

export interface Counts {
  readonly added: number | null;
  readonly deleted: number | null;
}

export function parseNumstat(stdout: string): Map<string, Counts> {
  const tokens = splitNul(stdout);
  const counts = new Map<string, Counts>();
  for (let i = 0; i < tokens.length; ) {
    const fields = (tokens[i] ?? '').split('\t');
    i += 1;
    const added = fields[0] === '-' ? null : Number(fields[0]);
    const deleted = fields[1] === '-' ? null : Number(fields[1]);
    // A rename splits its two paths into their own NUL-terminated records.
    let path = fields[2] ?? '';
    if (path === '') {
      i += 1; // the old path
      path = tokens[i] ?? '';
      i += 1;
    }
    counts.set(path, { added, deleted });
  }
  return counts;
}
