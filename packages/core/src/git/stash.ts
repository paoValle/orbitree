/**
 * Parser for `git stash list --format=…`, which prints one line per stash, newest first.
 *
 * The same two rules as every other parser in `git/`:
 *   1. it never throws — a line that is not a stash line is a value (`ParseResult`), because
 *      a repository we have not seen yet is a message and not a crash;
 *   2. it never silently drops a record — every entry keeps the raw line it came from.
 */
import { FIELD_SEP } from './command.ts';
import type { ParseResult } from './status.ts';

/** One stash, in the order git prints them: `stash@{0}` is the most recent. */
export interface StashEntry {
  /** `stash@{0}` — the selector git itself accepts (`stash apply stash@{0}`). */
  readonly selector: string;
  /** The stash commit. */
  readonly oid: string;
  /** Unix seconds. */
  readonly committedAt: number;
  readonly subject: string;
  /** The exact line git printed, kept so nothing parsed is lost. */
  readonly raw: string;
}

const SELECTOR = /^stash@\{\d+\}$/;

/** 40 hex characters for SHA-1, 64 for SHA-256, as `log.ts` accepts. */
const HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * A stash list is also a value when git printed nothing: an empty answer means the
 * repository holds no stash, which is a state and not a failure.
 */
export function parseStashList(stdout: string): ParseResult<readonly StashEntry[]> {
  const entries: StashEntry[] = [];
  const lines = stdout.split('\n');
  // git terminates the last line, so the tail is one empty string.
  if (lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    const parsed = parseStashEntry(line);
    if (!parsed.ok) return parsed;
    entries.push(parsed.value);
  }
  return { ok: true, value: entries };
}

function parseStashEntry(record: string): ParseResult<StashEntry> {
  const fields = record.split(FIELD_SEP);
  // The subject is free-form and last, so a separator inside it belongs to it: everything
  // after the third field is the subject, whatever it contains.
  if (fields.length < 4) {
    return { ok: false, error: 'a stash line is selector, oid, timestamp and subject', record };
  }
  const selector = fields[0] as string;
  if (!SELECTOR.test(selector)) {
    return { ok: false, error: `not a stash selector: ${selector}`, record };
  }
  const oid = fields[1] as string;
  if (!HASH.test(oid)) {
    return { ok: false, error: 'the second field is not a commit hash', record };
  }
  const seconds = fields[2] as string;
  if (!/^\d+$/.test(seconds)) {
    return { ok: false, error: 'the third field is not a unix timestamp', record };
  }
  return {
    ok: true,
    value: {
      selector,
      oid,
      committedAt: Number.parseInt(seconds, 10),
      subject: fields.slice(3).join(FIELD_SEP),
      raw: record,
    },
  };
}
