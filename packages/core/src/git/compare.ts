/**
 * Parser for `git log --left-right --cherry-pick A...B`.
 *
 * One read answers both halves of "what does each side have that the other does not": git marks every
 * commit with the side it is only on — `%m` prints `<` for the left, `>` for the right, `-` at the
 * boundary of a shallow read — and `--cherry-pick` leaves out the commits whose patch is already on the
 * other side. That last part is the difference between two branches having different *commits* and
 * having different *work*, and it is the reason this is git's answer rather than a set difference of
 * two hash lists.
 *
 * The mark is one character of the format, so this parser strips it and hands the rest to `parseLog`:
 * one log parser, one set of rules about a hash, a parent list and a free-form subject. Total, as
 * everything in `git/` is — a record with no mark, or a body that `parseLog` refuses, is a value.
 */
import type { Commit } from './log.ts';
import { parseLog } from './log.ts';
import type { ParseResult } from './status.ts';

/** Which side of the two-dot expression a commit is only on. */
export type Side = 'left' | 'right' | 'boundary';

export interface MarkedCommit {
  readonly side: Side;
  readonly commit: Commit;
}

export function parseComparison(stdout: string): ParseResult<readonly MarkedCommit[]> {
  const records = stdout.split('\u0000');
  if (records[records.length - 1] === '') records.pop();

  const marks: Side[] = [];
  const stripped: string[] = [];
  for (const record of records) {
    if (record === '') continue;
    const mark = record.slice(0, 1);
    if (mark !== '<' && mark !== '>' && mark !== '-') {
      return {
        ok: false,
        error: 'a comparison record does not start with a left/right mark',
        record,
      };
    }
    marks.push(mark === '<' ? 'left' : mark === '>' ? 'right' : 'boundary');
    stripped.push(record.slice(1));
  }

  // The same parser the graph uses, on the same format with the mark taken off: a second parser for a
  // log line would be a second set of rules about what a hash and a subject are.
  const parsed = parseLog(stripped.join('\u0000'));
  if (!parsed.ok) return parsed;
  if (parsed.value.length !== marks.length) {
    return {
      ok: false,
      error: `the comparison read ${marks.length} marks and ${parsed.value.length} commits`,
      record: stdout.slice(0, 200),
    };
  }
  return {
    ok: true,
    value: parsed.value.map((commit, index) => ({
      side: marks[index] ?? 'boundary',
      commit,
    })),
  };
}

export interface Comparison {
  /** The revision named as the left side, as the caller spelled it. */
  readonly left: string;
  readonly right: string;
  /** The commits only the left has, newest first. */
  readonly onlyLeft: readonly Commit[];
  /** The commits only the right has, newest first. */
  readonly onlyRight: readonly Commit[];
  /** Every record in git's order, with the side it was marked as. */
  readonly records: readonly MarkedCommit[];
}
