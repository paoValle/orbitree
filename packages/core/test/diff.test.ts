import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DiffFile, type DiffHunk, parseDiff } from '../src/git/diff.ts';
import { type FixtureSet, git, makeFixtures } from './support/fixtures.ts';
import {
  type Counts,
  parseNameStatus,
  parseNumstat,
  splitNul,
} from './support/patch-crosscheck.ts';

let set: FixtureSet;
let root = '';
// `diffable` covers every shape in one patch; `nasty` covers the names that need quoting,
// which is where a path really breaks.
const CHECKED_FIXTURES = ['diffable', 'nasty'] as const;

beforeAll(async () => {
  set = await makeFixtures();
  root = set.fixtures.find((fixture) => fixture.name === 'diffable')?.root ?? '';
});

afterAll(async () => {
  await set?.cleanup();
});

function fixtureRoot(name: string): string {
  const fixture = set.fixtures.find((candidate) => candidate.name === name);
  if (fixture === undefined) throw new Error(`the ${name} fixture is missing`);
  return fixture.root;
}

async function patch(where = root): Promise<string> {
  return (await git(where, 'diff', '--patch', '--find-renames', 'HEAD')).stdout;
}

async function parsedPatch(where = root): Promise<readonly DiffFile[]> {
  const result = parseDiff(await patch(where));
  if (!result.ok) throw new Error(`parseDiff failed: ${result.error} on ${result.record}`);
  return result.value;
}

function countLines(hunks: readonly DiffHunk[], kind: 'add' | 'del'): number {
  return hunks.reduce(
    (total, hunk) => total + hunk.lines.filter((line) => line.kind === kind).length,
    0,
  );
}

function reconstructHunk(hunk: DiffHunk): string {
  const lines = hunk.lines.map((line) => {
    if (line.kind === 'add') return `+${line.text}`;
    if (line.kind === 'del') return `-${line.text}`;
    if (line.kind === 'context') return ` ${line.text}`;
    return line.text;
  });
  return `${hunk.header}\n${lines.join('\n')}\n`;
}

describe('a real patch, parsed against git itself', () => {
  for (const name of CHECKED_FIXTURES) {
    it(`[I5] the parsed files agree with git's own --name-status and --numstat (${name})`, async () => {
      const where = fixtureRoot(name);
      const files = await parsedPatch(where);
      const parsedPaths = new Map(files.map((file) => [file.path, file.status] as const));

      const nameStatus = await git(where, 'diff', '--name-status', '-z', '-M', 'HEAD');
      expect(parsedPaths).toEqual(parseNameStatus(nameStatus.stdout));

      const numstat = await git(where, 'diff', '--numstat', '-z', '-M', 'HEAD');
      const counts = parseNumstat(numstat.stdout);
      expect(counts.size).toBe(files.length);
      for (const file of files) {
        const actual: Counts = {
          added: countLines(file.hunks, 'add'),
          deleted: countLines(file.hunks, 'del'),
        };
        if (file.binary) {
          // numstat spells a binary file's numbers as `-`, not zero.
          expect(counts.get(file.path), `${file.path} is binary`).toEqual({
            added: null,
            deleted: null,
          });
        } else {
          expect(counts.get(file.path), `${file.path} counts`).toEqual(actual);
        }
      }
    });

    it(`[I5] every path matches git's own NUL-separated path (${name})`, async () => {
      const where = fixtureRoot(name);
      const files = await parsedPatch(where);
      const nameOnly = await git(where, 'diff', '--name-only', '-z', '-M', 'HEAD');
      expect(new Set(files.map((file) => file.path))).toEqual(new Set(splitNul(nameOnly.stdout)));
    });
  }

  it("[I4] no line of git's output is dropped", async () => {
    const files = await parsedPatch();
    for (const file of files) {
      for (const hunk of file.hunks) {
        expect(hunk.raw, `${file.path}: hunk raw`).toBe(reconstructHunk(hunk));
      }
      const hunkBytes = file.hunks.reduce((total, hunk) => total + hunk.raw.length, 0);
      const header = file.raw.slice(0, file.raw.length - hunkBytes);
      expect(header + file.hunks.map(reconstructHunk).join(''), `${file.path}: section`).toBe(
        file.raw,
      );
    }
    // The whole patch is the sections, in order, with nothing added or lost between them.
    expect(files.map((file) => file.raw).join('')).toBe(await patch());
  });

  it('[I4] the hunk header numbers match the hunk body', async () => {
    const files = await parsedPatch();
    for (const file of files) {
      for (const hunk of file.hunks) {
        const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(hunk.header);
        if (match === null) throw new Error(`not a hunk header: ${hunk.header}`);
        const headerOldLines = match[2] === undefined ? 1 : Number(match[2]);
        const headerNewLines = match[4] === undefined ? 1 : Number(match[4]);
        const context = hunk.lines.filter((line) => line.kind === 'context').length;
        const added = hunk.lines.filter((line) => line.kind === 'add').length;
        const deleted = hunk.lines.filter((line) => line.kind === 'del').length;

        expect(context + deleted, `${file.path}: old side`).toBe(headerOldLines);
        expect(context + added, `${file.path}: new side`).toBe(headerNewLines);
        expect(hunk.oldStart).toBe(Number(match[1]));
        expect(hunk.oldLines).toBe(headerOldLines);
        expect(hunk.newStart).toBe(Number(match[3]));
        expect(hunk.newLines).toBe(headerNewLines);
      }
    }
  });

  it('[I4] malformed input is a value, never an exception', async () => {
    const broken = [
      'not a diff at all\n',
      'diff --git\n',
      'diff --git a/x b/x\n@@ nope @@\n',
      'diff --git a/x b/x\n@@ -1 +1 @@\n?invalid marker\n',
      'diff --git a/x b/x\nan unknown header line\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n',
      'diff --git "a/unterminated b/x\n',
      'diff --git a/x b/x\n@@ -1 +1 @@\n+a line\nnot a marked line\n',
    ];
    for (const record of broken) {
      const parsed = parseDiff(record);
      expect(parsed.ok, record).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.length).toBeGreaterThan(0);
        expect(parsed.record.length).toBeGreaterThan(0);
      }
    }

    // Byte mutations of a real patch: the parser must answer, not crash.
    const raw = await patch();
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat({ max: 4000 }), fc.integer({ min: 0, max: 255 })), {
          maxLength: 16,
        }),
        (mutations) => {
          const bytes = Buffer.from(raw, 'utf8');
          if (bytes.length === 0) return true;
          for (const [position, value] of mutations) bytes[position % bytes.length] = value;
          const parsed = parseDiff(bytes.toString('utf8'));
          return typeof parsed.ok === 'boolean';
        },
      ),
      { numRuns: 300 },
    );
  });

  it('[I4] a binary file and a missing trailing newline are handled', async () => {
    const files = await parsedPatch();

    const binary = files.find((file) => file.path === 'image.png');
    expect(binary).toBeDefined();
    expect(binary?.binary).toBe(true);
    expect(binary?.hunks).toEqual([]);

    const noNewline = files.find((file) => file.path === 'no-newline.txt');
    expect(noNewline).toBeDefined();
    const notes =
      noNewline?.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind === 'note') ?? [];
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.some((line) => line.text.includes('No newline at end of file'))).toBe(true);
  });
});
