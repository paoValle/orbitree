/**
 * Parser for `git diff --patch`.
 *
 * The same two rules hold here as in `status.ts` and `log.ts`: it never throws — a record
 * it cannot understand is a value — and it never silently drops a line. Every line of a
 * file section is reachable through `raw`, and every hunk line through `hunk.lines`, so a
 * caller can print the patch a person expects while reading the structure an agent needs.
 */
import { TextDecoder, TextEncoder } from 'node:util';
import type { ParseResult } from './status.ts';

export type DiffLineKind = 'context' | 'add' | 'del' | 'note';

export interface DiffLine {
  readonly kind: DiffLineKind;
  /** Without the leading `+`, `-` or space. A `note` keeps its whole text. */
  readonly text: string;
}

export interface DiffHunk {
  /** The raw `@@ -a,b +c,d @@ section title` line. */
  readonly header: string;
  readonly oldStart: number;
  /** Recomputed from the parsed lines: context + del. */
  readonly oldLines: number;
  readonly newStart: number;
  /** Recomputed from the parsed lines: context + add. */
  readonly newLines: number;
  readonly lines: readonly DiffLine[];
  /** The whole hunk, exactly as git printed it. */
  readonly raw: string;
}

export type DiffFileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';

export interface DiffFile {
  /** The new path, unquoted and without an `a/` or `b/` prefix. */
  readonly path: string;
  /** Set only when the file was renamed or copied. */
  readonly oldPath: string | null;
  readonly status: DiffFileStatus;
  readonly binary: boolean;
  readonly hunks: readonly DiffHunk[];
  /** The whole file section, exactly as git printed it. */
  readonly raw: string;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const SIMPLE_ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  f: 12,
  n: 10,
  r: 13,
  t: 9,
  v: 11,
  '\\': 92,
  '"': 34,
};

export function parseDiff(stdout: string): ParseResult<readonly DiffFile[]> {
  if (stdout === '') return { ok: true, value: [] };
  const lines = splitLines(stdout);
  const files: DiffFile[] = [];
  let index = 0;

  while (index < lines.length) {
    const first = lines[index];
    if (first === undefined) break;
    if (!first.startsWith('diff --git ')) {
      return { ok: false, error: 'a section does not start with "diff --git"', record: first };
    }
    let end = index + 1;
    while (end < lines.length && !(lines[end] as string).startsWith('diff --git ')) end += 1;

    const section = lines.slice(index, end);
    const raw = sliceLines(lines, index, end, end < lines.length || stdout.endsWith('\n'));
    const parsed = parseFileSection(section, raw);
    if (!parsed.ok) return parsed;
    files.push(parsed.value);
    index = end;
  }

  return { ok: true, value: files };
}

function parseFileSection(section: readonly string[], raw: string): ParseResult<DiffFile> {
  const header = section[0] as string;
  const fromHeader = parseGitHeader(header);
  if (fromHeader === null) {
    return {
      ok: false,
      error: 'could not read the paths from the "diff --git" header',
      record: header,
    };
  }

  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let copyFrom: string | null = null;
  let copyTo: string | null = null;
  // `undefined` means "no marker line"; `null` means git printed `/dev/null`.
  let markerOld: string | null | undefined;
  let markerNew: string | null | undefined;
  let binary = false;
  let addedMode = false;
  let deletedMode = false;

  let hunkStart = section.length;
  for (let i = 1; i < section.length; i += 1) {
    const line = section[i] as string;
    if (line.startsWith('@@')) {
      hunkStart = i;
      break;
    }
    if (line.startsWith('index ')) continue;
    if (line.startsWith('old mode ') || line.startsWith('new mode ')) continue;
    if (line.startsWith('similarity index ') || line.startsWith('dissimilarity index ')) continue;
    if (line.startsWith('new file mode ')) {
      addedMode = true;
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      deletedMode = true;
      continue;
    }
    if (line.startsWith('rename from ')) {
      const parsed = readPath(line.slice('rename from '.length));
      if (!parsed.ok) return pathError(line);
      renameFrom = parsed.value;
      continue;
    }
    if (line.startsWith('rename to ')) {
      const parsed = readPath(line.slice('rename to '.length));
      if (!parsed.ok) return pathError(line);
      renameTo = parsed.value;
      continue;
    }
    if (line.startsWith('copy from ')) {
      const parsed = readPath(line.slice('copy from '.length));
      if (!parsed.ok) return pathError(line);
      copyFrom = parsed.value;
      continue;
    }
    if (line.startsWith('copy to ')) {
      const parsed = readPath(line.slice('copy to '.length));
      if (!parsed.ok) return pathError(line);
      copyTo = parsed.value;
      continue;
    }
    if (line.startsWith('--- ')) {
      const parsed = readMarker(line.slice(4));
      if (!parsed.ok) return pathError(line);
      markerOld = parsed.value;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const parsed = readMarker(line.slice(4));
      if (!parsed.ok) return pathError(line);
      markerNew = parsed.value;
      continue;
    }
    if (line.startsWith('Binary files ') && line.endsWith(' differ')) {
      binary = true;
      continue;
    }
    return { ok: false, error: 'an unknown line in a file header', record: line };
  }

  if ((renameFrom === null) !== (renameTo === null)) {
    return {
      ok: false,
      error: 'a rename has only one of "rename from" / "rename to"',
      record: header,
    };
  }
  if ((copyFrom === null) !== (copyTo === null)) {
    return { ok: false, error: 'a copy has only one of "copy from" / "copy to"', record: header };
  }

  const hunks: DiffHunk[] = [];
  const endOfSection = raw.endsWith('\n');
  let i = hunkStart;
  while (i < section.length) {
    const headerLine = section[i] as string;
    const match = HUNK_HEADER.exec(headerLine);
    if (match === null) {
      return { ok: false, error: 'a hunk header is not "@@ -a,b +c,d @@"', record: headerLine };
    }

    let j = i + 1;
    const hunkLines: DiffLine[] = [];
    while (j < section.length && !(section[j] as string).startsWith('@@')) {
      const body = section[j] as string;
      const marker = body[0];
      if (marker === ' ') hunkLines.push({ kind: 'context', text: body.slice(1) });
      else if (marker === '+') hunkLines.push({ kind: 'add', text: body.slice(1) });
      else if (marker === '-') hunkLines.push({ kind: 'del', text: body.slice(1) });
      else if (marker === '\\') hunkLines.push({ kind: 'note', text: body });
      else {
        return {
          ok: false,
          error: 'a hunk line does not start with " ", "+", "-" or "\\"',
          record: body,
        };
      }
      j += 1;
    }

    const oldLines = hunkLines.reduce(
      (count, line) => count + (line.kind === 'context' || line.kind === 'del' ? 1 : 0),
      0,
    );
    const newLines = hunkLines.reduce(
      (count, line) => count + (line.kind === 'context' || line.kind === 'add' ? 1 : 0),
      0,
    );
    hunks.push({
      header: headerLine,
      oldStart: Number.parseInt(match[1] as string, 10),
      oldLines,
      newStart: Number.parseInt(match[3] as string, 10),
      newLines,
      lines: hunkLines,
      raw: sliceLines(section, i, j, j < section.length || endOfSection),
    });
    i = j;
  }

  let path: string;
  let oldPath: string | null = null;
  let status: DiffFileStatus;
  if (renameFrom !== null && renameTo !== null) {
    status = 'renamed';
    path = renameTo;
    oldPath = renameFrom;
  } else if (copyFrom !== null && copyTo !== null) {
    status = 'copied';
    path = copyTo;
    oldPath = copyFrom;
  } else if (addedMode || markerOld === null) {
    status = 'added';
    path = markerNew ?? fromHeader.new;
  } else if (deletedMode || markerNew === null) {
    status = 'deleted';
    path = markerOld ?? fromHeader.old;
  } else {
    status = 'modified';
    path = markerNew ?? markerOld ?? fromHeader.new;
  }

  return { ok: true, value: { path, oldPath, status, binary, hunks, raw } };
}

interface HeaderPaths {
  readonly old: string;
  readonly new: string;
}

/**
 * The `diff --git a/x b/y` line. Parsing it is only a fallback — `---`/`+++`,
 * `rename from/to` and `Binary files` carry quoted paths of their own — but a binary file
 * prints no `---`/`+++`, so this is where its path comes from.
 */
function parseGitHeader(line: string): HeaderPaths | null {
  const rest = line.slice('diff --git '.length);
  if (rest === '') return null;

  if (rest.startsWith('"')) {
    const first = readQuotedToken(rest, 0);
    if (first === null || rest[first.end] !== ' ') return null;
    const second = readQuotedToken(rest, first.end + 1);
    if (second === null || second.end !== rest.length) return null;
    return { old: stripPrefix(first.value), new: stripPrefix(second.value) };
  }

  const splitMarker = ' b/';
  let lastSplit = -1;
  for (let at = rest.indexOf(splitMarker); at !== -1; at = rest.indexOf(splitMarker, at + 1)) {
    lastSplit = at;
    const left = rest.slice(0, at);
    const right = rest.slice(at + 1);
    // A plain modification prints the same path twice; matching them removes the
    // ambiguity a space in the name would otherwise create.
    if (left.startsWith('a/') && right.startsWith('b/') && left.slice(2) === right.slice(2)) {
      return { old: left.slice(2), new: right.slice(2) };
    }
  }
  if (lastSplit !== -1) {
    const left = rest.slice(0, lastSplit);
    const right = rest.slice(lastSplit + 1);
    if (left.startsWith('a/') && right.startsWith('b/')) {
      return { old: left.slice(2), new: right.slice(2) };
    }
  }
  return null;
}

function readPath(text: string): { readonly ok: true; readonly value: string } | PathFailure {
  if (!text.startsWith('"')) return { ok: true, value: text };
  const token = readQuotedToken(text, 0);
  if (token === null || token.end !== text.length) return { ok: false };
  return { ok: true, value: token.value };
}

/** A `---`/`+++` marker path, or `null` for `/dev/null`. */
function readMarker(
  text: string,
): { readonly ok: true; readonly value: string | null } | PathFailure {
  let value: string;
  if (text.startsWith('"')) {
    const token = readQuotedToken(text, 0);
    if (token === null) return { ok: false };
    const rest = text.slice(token.end);
    // When a name needs no quoting but contains a space, git appends a tab to end the field.
    if (rest !== '' && rest !== '\t') return { ok: false };
    value = token.value;
  } else {
    value = text.endsWith('\t') ? text.slice(0, -1) : text;
  }
  if (value === '/dev/null') return { ok: true, value: null };
  return { ok: true, value: stripPrefix(value) };
}

interface PathFailure {
  readonly ok: false;
}

function pathError(line: string): {
  readonly ok: false;
  readonly error: string;
  readonly record: string;
} {
  return { ok: false, error: 'could not unquote a path in a file header', record: line };
}

/**
 * Git quotes a path when it contains bytes outside printable ASCII. The quoted form is a
 * C string whose non-ASCII bytes are octal escapes, so the bytes are collected and decoded
 * as UTF-8 rather than reversed character by character.
 */
function readQuotedToken(
  text: string,
  start: number,
): { readonly value: string; readonly end: number } | null {
  if (text[start] !== '"') return null;
  const bytes: number[] = [];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '"') return { value: decodeUtf8(bytes), end: i + 1 };
    if (ch === '\\') {
      i += 1;
      const escaped = text[i];
      if (escaped === undefined) return null;
      const simple = SIMPLE_ESCAPES[escaped];
      if (simple !== undefined) {
        bytes.push(simple);
        i += 1;
        continue;
      }
      if (escaped >= '0' && escaped <= '7') {
        let octal = escaped;
        while (octal.length < 3) {
          const next = text[i + 1];
          if (next === undefined || next < '0' || next > '7') break;
          octal += next;
          i += 1;
        }
        bytes.push(Number.parseInt(octal, 8));
        i += 1;
        continue;
      }
      return null;
    }
    for (const byte of new TextEncoder().encode(ch)) bytes.push(byte);
    i += 1;
  }
  return null;
}

function decodeUtf8(bytes: readonly number[]): string {
  return new TextDecoder('utf-8').decode(Uint8Array.from(bytes));
}

function stripPrefix(path: string): string {
  return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path;
}

function sliceLines(
  lines: readonly string[],
  from: number,
  to: number,
  endsWithNewline: boolean,
): string {
  const text = lines.slice(from, to).join('\n');
  return endsWithNewline ? `${text}\n` : text;
}

function splitLines(stdout: string): string[] {
  const lines = stdout.split('\n');
  // `git diff` ends every line with a newline, so the split leaves one empty tail.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * The patch for one hunk of one file: the file's own header lines followed by that hunk, both
 * exactly as git printed them.
 *
 * Nothing here is re-synthesised from the parsed fields. A patch rebuilt from our own reading of a
 * diff would be a second opinion about what git said, and `git apply` is entitled to reject it;
 * what travels is the text the parser kept. `--recount` on the apply side covers the one thing
 * that is ours: the line counts a caller might have adjusted.
 *
 * `null` when there is no such hunk, because a caller asking for the fourth hunk of a two-hunk
 * file has an answer and the answer is not an exception.
 */
export function patchForHunk(file: DiffFile, hunkIndex: number): string | null {
  const first = file.hunks[0];
  const hunk = file.hunks[hunkIndex];
  if (first === undefined || hunk === undefined) return null;
  // Everything before the first hunk is the file header: `diff --git`, `index`, `---`, `+++`.
  const header = file.raw.slice(0, file.raw.indexOf(first.raw));
  return `${header}${hunk.raw}${hunk.raw.endsWith('\n') ? '' : '\n'}`;
}
