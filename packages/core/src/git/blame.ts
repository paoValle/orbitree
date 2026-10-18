/**
 * Parser for `git blame --line-porcelain`.
 *
 * One line of the file at a time: a header naming the commit it came from, that commit's metadata,
 * and then the line's own text after a tab. `--line-porcelain` repeats the metadata for **every**
 * line rather than once per commit, which is more bytes and the reason this parser needs no state: a
 * block is complete on its own, so a truncated read loses the last line and never corrupts the ones
 * before it.
 *
 * The same two rules as every parser in `git/`: it never throws, and it never drops a record — each
 * line keeps the block git printed for it, so a header this version does not name is visible in
 * `raw` rather than gone. The blocks this version does read are the ones a person asks about: who
 * wrote this line, when, in which commit, and what that commit said.
 *
 * The lines are the *final* file's lines: blame answers "where did this line come from", so the
 * numbering is the file on screen, which is the only numbering a reader can point at.
 */
import type { ParseResult } from './status.ts';

export interface BlameLine {
  /** The line number in the file as it is, counted from 1. */
  readonly line: number;
  /** The line number in the commit that introduced it, which is where a "previous" search continues. */
  readonly originalLine: number;
  readonly oid: string;
  /** The commit's subject, as git prints it: the first line of the message. */
  readonly summary: string;
  readonly author: string;
  /** The email without git's angle brackets. */
  readonly authorMail: string;
  /** Seconds since the epoch, as git reports it. */
  readonly authorTime: number;
  /** The line's own text, without the leading tab and without its newline. */
  readonly content: string;
  /** True when git reached the edge of the history it was asked about. */
  readonly boundary: boolean;
  /** `<sha> <path>` of where the line came from before it moved, or `null`. */
  readonly previous: string | null;
  /** The block exactly as git printed it, content line included. */
  readonly raw: string;
}

const HEADER = /^(\^?)([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/;

export function parseBlame(stdout: string): ParseResult<readonly BlameLine[]> {
  const lines: BlameLine[] = [];
  const records = stdout.split('\n');
  let index = 0;

  while (index < records.length) {
    const header = records[index] ?? '';
    if (header === '') {
      index += 1;
      continue;
    }
    const match = HEADER.exec(header);
    if (match === null) {
      return {
        ok: false,
        error: 'a blame block does not start with a commit line',
        record: header,
      };
    }

    const block: string[] = [header];
    let summary = '';
    let author = '';
    let authorMail = '';
    let authorTime = 0;
    let boundary = match[1] === '^';
    let previous: string | null = null;
    let content: string | null = null;
    index += 1;

    while (index < records.length) {
      const line = records[index] ?? '';
      if (line.startsWith('\t')) {
        content = line.slice(1);
        block.push(line);
        index += 1;
        break;
      }
      if (line === '') break;
      // A new header before a content line is a block with no text, which cannot be a blamed line.
      if (HEADER.test(line)) break;
      block.push(line);
      const space = line.indexOf(' ');
      const key = space === -1 ? line : line.slice(0, space);
      const value = space === -1 ? '' : line.slice(space + 1);
      switch (key) {
        case 'summary':
          summary = value;
          break;
        case 'author':
          author = value;
          break;
        case 'author-mail':
          authorMail = value.replace(/^</, '').replace(/>$/, '');
          break;
        case 'author-time':
          authorTime = Number(value);
          break;
        case 'boundary':
          boundary = true;
          break;
        case 'previous':
          previous = value;
          break;
        default:
          // A key this version does not know stays in `raw`: git adds metadata, and an older product
          // reading a newer git's output should lose nothing.
          break;
      }
      index += 1;
    }

    if (content === null) {
      return {
        ok: false,
        error: 'a blame block has no content line',
        record: block.join('\n'),
      };
    }
    lines.push({
      line: Number(match[4]),
      originalLine: Number(match[3]),
      oid: match[2] ?? '',
      summary,
      author,
      authorMail,
      authorTime,
      content,
      boundary,
      previous,
      raw: block.join('\n'),
    });
  }

  return { ok: true, value: lines };
}

/** The commits a blamed file names, in the order the lines first mention them. */
export function blamedCommits(lines: readonly BlameLine[]): readonly string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const line of lines) {
    if (seen.has(line.oid)) continue;
    seen.add(line.oid);
    order.push(line.oid);
  }
  return order;
}
