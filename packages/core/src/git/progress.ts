/**
 * Parser for git's progress lines.
 *
 * `git fetch --progress`, `push --progress` and `pull --progress` write progress to stderr, one line
 * per update, separated by a carriage return rather than a newline so a terminal overwrites the same
 * row. The shapes are:
 *
 * ```
 * Counting objects:  45% (1234/2740)
 * Receiving objects:  45% (1234/2740), 1.20 MiB | 1.10 MiB/s
 * remote: Resolving deltas: 100% (500/500), done.
 * Enumerating objects: 4, done.
 * ```
 *
 * Two rules, the same as every other parser in `git/`: it never throws, and it never drops anything —
 * a line it does not understand is `null` here and stays in the raw `stderr` a caller already has.
 *
 * The phase names are checked rather than guessed, which is not how a parser usually works and is
 * how this one has to: git writes progress and errors to the same stream, and a pattern loose enough
 * to match any `word: text` line reads `fatal: unable to access 'https://…'` as a phase called
 * "fatal" progressing to nothing. Only the phases git actually reports, and only with a percentage or
 * a `done.`, count.
 */
import type { ParseResult } from './status.ts';

export interface Progress {
  /** git's own name for the phase: `Counting objects`, `Receiving objects`, `Resolving deltas`. */
  readonly phase: string;
  /** How far along, 0–100, or `null` when this line carries a count instead of a percentage. */
  readonly percent: number | null;
  /** What git put after the percentage, or the count when there is no percentage. */
  readonly detail: string;
  /** The line exactly as git printed it, without the carriage return. */
  readonly raw: string;
}

/** git's own progress phases, checked rather than guessed. See the note at the top. */
const PHASES = [
  'Counting objects',
  'Compressing objects',
  'Receiving objects',
  'Enumerating objects',
  'Writing objects',
  'Resolving deltas',
  'Checking out files',
  'Updating files',
  'Updating index',
  'Checking connectivity',
  'Finding sources',
  'Expanding reachable commits in delta island',
  'Checking objects',
];

const LINE = /^(?:remote:\s*)?(.+?):\s+(?:(\d{1,3})% \((\d+)\/(\d+)\)(?:,\s*(.*))?|(.*))$/;

export function parseProgressLine(line: string): Progress | null {
  const raw = line.replace(/\r$/, '');
  const match = LINE.exec(raw);
  if (match === null) return null;
  const phase = match[1] ?? '';
  if (!PHASES.includes(phase)) return null;

  const percent = match[2];
  if (percent !== undefined) {
    // Trimmed for display, padded in `raw`: git pads the line so that its next update overwrites the
    // same width, and those spaces are not part of what it is saying.
    return { phase, percent: Number(percent), detail: (match[5] ?? '').trim(), raw };
  }
  // No percentage: a count, and git only writes one when the phase is finished with it.
  const count = (match[6] ?? '').trim();
  if (!/^[\d,]+(\s*,?\s*done\.?)?$/.test(count)) return null;
  return { phase, percent: null, detail: count, raw };
}

/**
 * Every progress line in a block of stderr, in order, parsed. The last one is how far the command
 * got, which is what a caller that only sees the result wants.
 */
export function parseProgress(stdout: string): ParseResult<readonly Progress[]> {
  const progress: Progress[] = [];
  // Split on both separators, not on `\r?\n`: git separates progress lines with a carriage return
  // and nothing else, so a newline-only split leaves a whole transfer as one line whose `^`-anchored
  // match reads only the first update of it. That is what the test that compares the streaming lines
  // with the buffered ones caught.
  for (const line of stdout.split(/\r|\n/)) {
    const parsed = parseProgressLine(line);
    if (parsed !== null) progress.push(parsed);
  }
  return { ok: true, value: progress };
}

/** A progress line in words, for a terminal or a log: `Receiving objects 45% · 1.20 MiB | 1.10 MiB/s`. */
export function describeProgress(progress: Progress): string {
  const head =
    progress.percent === null ? progress.phase : `${progress.phase} ${progress.percent}%`;
  return progress.detail === '' ? head : `${head} · ${progress.detail}`;
}
