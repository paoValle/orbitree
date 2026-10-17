/**
 * Parser for `git remote -v`.
 *
 * The same two rules as every other parser in `git/`: it never throws — a line it cannot understand
 * is a value — and it never drops a record, because every remote keeps the lines git printed for it.
 *
 * The format is one line per URL, `<name>\t<url> (fetch)` or `<name>\t<url> (push)`, so a remote is
 * two lines unless its push URL differs. Grouping them here rather than in each front-end is the
 * reason this is a parser and not a `split('\n')` at the call site: a remote is one thing with two
 * URLs, and a screen that showed it twice would be showing git's output instead of its meaning.
 */
import type { ParseResult } from './status.ts';

export interface Remote {
  readonly name: string;
  /** The URL it fetches from, or `null` when git printed no fetch line. */
  readonly fetchUrl: string | null;
  /** The URL it pushes to: the same one unless somebody set it apart. */
  readonly pushUrl: string | null;
  /** The lines git printed, so nothing is lost to the grouping. */
  readonly raw: readonly string[];
}

const LINE = /^(\S+)\t(.*) \((fetch|push)\)$/;

export function parseRemotes(stdout: string): ParseResult<readonly Remote[]> {
  const order: string[] = [];
  const byName = new Map<
    string,
    { fetchUrl: string | null; pushUrl: string | null; raw: string[] }
  >();

  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    const match = LINE.exec(line);
    if (match === null) {
      return {
        ok: false,
        error: 'a `remote -v` line is not `<name>\\t<url> (fetch|push)`',
        record: line,
      };
    }
    const name = match[1] ?? '';
    const url = match[2] ?? '';
    const kind = match[3] ?? 'fetch';
    let entry = byName.get(name);
    if (entry === undefined) {
      entry = { fetchUrl: null, pushUrl: null, raw: [] };
      byName.set(name, entry);
      order.push(name);
    }
    if (kind === 'push') entry.pushUrl = url;
    else entry.fetchUrl = url;
    entry.raw.push(line);
  }

  const remotes: Remote[] = [];
  for (const name of order) {
    const entry = byName.get(name);
    // Filled above, so it is there: the order list and the map are written together.
    if (entry === undefined) continue;
    remotes.push({ name, fetchUrl: entry.fetchUrl, pushUrl: entry.pushUrl, raw: entry.raw });
  }
  return { ok: true, value: remotes };
}
