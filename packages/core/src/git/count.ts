import type { ParseResult } from './status.ts';

/**
 * `git rev-list --count` prints one integer and a newline, and nothing else. Anything
 * other than that is a value, not an exception, like every other parser here. The
 * trailing newline is git's, not part of the number.
 */
export function parseCommitCount(stdout: string): ParseResult<number> {
  const match = /^(\d+)\s*$/.exec(stdout);
  if (match === null) {
    return { ok: false, error: 'a commit count is a single integer', record: stdout };
  }
  return { ok: true, value: Number.parseInt(match[1] as string, 10) };
}
