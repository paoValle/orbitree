/**
 * The conflict regions of a file, and the patch that resolves one of them.
 *
 * A conflicted file is text git wrote: `<<<<<<< ours`, `=======`, `>>>>>>> theirs` around the two
 * versions of one region. This module reads those markers and builds the patch that replaces one
 * region with either side, both sides, or a caller's own text.
 *
 * The patch is *built* rather than diffed. The lines to remove are the region's own, taken from the
 * file as it is on disk; the lines to add are the choice; the context comes from the same read. So
 * the only lines this can change are the ones between markers — a property worth more than the
 * generality of a diff algorithm, because a diff of our own would be a second, worse
 * implementation of something git already does, and a wrong one is a patch that applies to the
 * wrong lines. `git apply --recount` covers the one thing that is genuinely ours: the counts.
 */

/** The three markers, as git writes them. The label after each one is git's and is not read. */
const OURS = '<<<<<<<';
const SEPARATOR = '=======';
const THEIRS = '>>>>>>>';

/** Context lines around a region, which is what makes `git apply` refuse a file that has moved. */
const CONTEXT = 3;

export interface ConflictRegion {
  /** 0-based index of the `<<<<<<<` line. */
  readonly start: number;
  /** 0-based index of the `>>>>>>>` line, inclusive: the whole region is `start..end`. */
  readonly end: number;
  readonly ours: readonly string[];
  readonly theirs: readonly string[];
}

/**
 * Every region the markers describe, in order.
 *
 * A file whose markers do not pair up yields the regions that do: a caller comparing the count
 * against the number of `<<<<<<<` lines it saw is what turns a half-written file into an error
 * rather than into a resolution that leaves a marker behind.
 */
export function parseConflictRegions(lines: readonly string[]): readonly ConflictRegion[] {
  const regions: ConflictRegion[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!(lines[index] as string).startsWith(OURS)) {
      index += 1;
      continue;
    }
    const ours: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length && !(lines[cursor] as string).startsWith(SEPARATOR)) {
      ours.push(lines[cursor] as string);
      cursor += 1;
    }
    if (cursor >= lines.length) break;
    const theirs: string[] = [];
    cursor += 1;
    while (cursor < lines.length && !(lines[cursor] as string).startsWith(THEIRS)) {
      theirs.push(lines[cursor] as string);
      cursor += 1;
    }
    if (cursor >= lines.length) break;
    regions.push({ start: index, end: cursor, ours, theirs });
    index = cursor + 1;
  }
  return regions;
}

/** How many regions a file claims to have, which is how a partially parsed one is noticed. */
export function countConflictStarts(lines: readonly string[]): number {
  return lines.filter((line) => line.startsWith(OURS)).length;
}

/**
 * A path as a patch header writes it. git quotes a path with a space, a quote or a control
 * character, and `git apply` reads the quoted form back.
 *
 * shortcut: only the double-quote, backslash and space cases are escaped. A path with a character
 * outside ASCII is written unquoted, which git accepts and which is what a person's own patch would
 * look like; if it ever has to be exact, this is the function to finish.
 */
function quotePath(path: string): string {
  if (!/[\s"\\]/.test(path)) return path;
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The patch that replaces one region with `replacement`, to be applied with `git apply`.
 *
 * Every added line is prefixed, which is what makes a caller's text inert: a line of it that reads
 * `--- a/etc/passwd` becomes `+--- a/etc/passwd`, one added line, and cannot become a header.
 */
export function resolutionPatch(
  path: string,
  lines: readonly string[],
  region: ConflictRegion,
  replacement: readonly string[],
): string {
  const from = Math.max(0, region.start - CONTEXT);
  const to = Math.min(lines.length, region.end + 1 + CONTEXT);
  const removed = region.end - region.start + 1;
  const before = region.start - from;
  const after = to - region.end - 1;

  const body: string[] = [];
  for (let index = from; index < region.start; index += 1) body.push(` ${lines[index] as string}`);
  for (let index = region.start; index <= region.end; index += 1)
    body.push(`-${lines[index] as string}`);
  for (const line of replacement) body.push(`+${line}`);
  for (let index = region.end + 1; index < to; index += 1) body.push(` ${lines[index] as string}`);

  const header = `@@ -${from + 1},${before + removed + after} +${from + 1},${before + replacement.length + after} @@`;
  const quoted = quotePath(path);
  return [
    `diff --git a/${quoted} b/${quoted}`,
    `--- a/${quoted}`,
    `+++ b/${quoted}`,
    header,
    ...body,
    '',
  ].join('\n');
}
