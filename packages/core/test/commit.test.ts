import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DiffHunk } from '../src/git/diff.ts';
import { DETAIL_FORMAT, openRepo, parseCommitDetail, readCommit } from '../src/index.ts';
import { type FixtureSet, git, makeFixtures } from './support/fixtures.ts';
import { type Counts, parseNameStatus, parseNumstat } from './support/patch-crosscheck.ts';

let set: FixtureSet;
let where = '';
let merge = '';
let root = '';
let normal = '';

beforeAll(async () => {
  set = await makeFixtures();
  where = set.fixtures.find((fixture) => fixture.name === 'history')?.root ?? '';
  // Reach the three shapes by revision: HEAD is the tagged merge's first parent (itself a
  // merge), the root is the only parentless commit, and `feature-a` is an ordinary commit.
  merge = (await git(where, 'rev-parse', 'HEAD')).stdout.trim();
  root = (await git(where, 'rev-list', '--max-parents=0', 'HEAD')).stdout.trim();
  normal = (await git(where, 'rev-parse', 'feature-a')).stdout.trim();
});

afterAll(async () => {
  await set?.cleanup();
});

interface RawMetadata {
  readonly hash: string;
  readonly parents: string;
  readonly name: string;
  readonly email: string;
  readonly authoredAt: string;
  readonly committedAt: string;
}

/** Every field the parser claims, read straight from git's own `%` placeholders. */
async function rawMetadata(rev: string): Promise<RawMetadata> {
  const out = (await git(where, 'log', '-1', '--format=%H%n%P%n%an%n%ae%n%at%n%ct', rev)).stdout;
  const [hash, parents, name, email, authoredAt, committedAt] = out.split('\n');
  return {
    hash: hash ?? '',
    parents: parents ?? '',
    name: name ?? '',
    email: email ?? '',
    authoredAt: authoredAt ?? '',
    committedAt: committedAt ?? '',
  };
}

function countLines(hunks: readonly DiffHunk[], kind: 'add' | 'del'): number {
  return hunks.reduce(
    (total, hunk) => total + hunk.lines.filter((line) => line.kind === kind).length,
    0,
  );
}

describe('a commit read as data', () => {
  it('[I5] the metadata agrees with git', async () => {
    const repo = await openRepo(where);
    const cases = [
      { name: 'merge', rev: merge },
      { name: 'root', rev: root },
      { name: 'normal', rev: normal },
    ];
    for (const item of cases) {
      const { commit } = await readCommit(repo, { rev: item.rev });
      const raw = await rawMetadata(item.rev);
      expect(commit.hash, item.name).toBe(raw.hash);
      expect(commit.parents, item.name).toEqual(raw.parents === '' ? [] : raw.parents.split(' '));
      expect(commit.author.name, item.name).toBe(raw.name);
      expect(commit.author.email, item.name).toBe(raw.email);
      expect(commit.authoredAt, item.name).toBe(Number(raw.authoredAt));
      expect(commit.committedAt, item.name).toBe(Number(raw.committedAt));
    }
  });

  it('[I5] the body is exactly what git prints', async () => {
    const repo = await openRepo(where);

    const withBody = await readCommit(repo, { rev: normal });
    expect(withBody.commit.body).toContain('\n');
    const rawBody = (await git(where, 'log', '-1', '--format=%B', normal)).stdout;
    expect(`${withBody.commit.subject}\n\n${withBody.commit.body}`.trimEnd()).toBe(
      rawBody.trimEnd(),
    );

    const single = await readCommit(repo, { rev: root });
    expect(single.commit.body).toBe('');
  });

  it("[I5] the patch is the first parent's diff", async () => {
    const repo = await openRepo(where);
    const cases = [
      { name: 'merge', rev: merge, against: 'first-parent' },
      { name: 'normal', rev: normal, against: 'parent' },
      { name: 'root', rev: root, against: 'root' },
    ] as const;

    for (const item of cases) {
      const data = await readCommit(repo, { rev: item.rev });
      expect(data.against, item.name).toBe(item.against);

      const parsedPaths = new Map(data.files.map((file) => [file.path, file.status] as const));
      const nameStatus = await git(
        where,
        'show',
        '--name-status',
        '--format=',
        '-z',
        '-M',
        '-m',
        '--first-parent',
        item.rev,
      );
      expect(parsedPaths, item.name).toEqual(parseNameStatus(nameStatus.stdout));

      const numstat = await git(
        where,
        'show',
        '--numstat',
        '--format=',
        '-z',
        '-M',
        '-m',
        '--first-parent',
        item.rev,
      );
      const counts = parseNumstat(numstat.stdout);
      expect(counts.size, item.name).toBe(data.files.length);
      for (const file of data.files) {
        if (file.binary) {
          // numstat spells a binary file's numbers as `-`, not zero.
          expect(counts.get(file.path), `${item.name}: ${file.path} is binary`).toEqual({
            added: null,
            deleted: null,
          });
        } else {
          const actual: Counts = {
            added: countLines(file.hunks, 'add'),
            deleted: countLines(file.hunks, 'del'),
          };
          expect(counts.get(file.path), `${item.name}: ${file.path} counts`).toEqual(actual);
        }
      }
    }
  });

  it('[I5] a merge is not shown as an empty patch', async () => {
    const repo = await openRepo(where);
    const data = await readCommit(repo, { rev: merge });
    // Plain `git show` prints nothing for a merge; `-m --first-parent` is what makes this
    // non-empty, so the regression is asserted where it would reappear.
    expect(data.against).toBe('first-parent');
    expect(data.files.length).toBeGreaterThan(0);
  });
});

describe('malformed metadata', () => {
  it('[I4] malformed metadata is a value, never an exception', async () => {
    const hash = 'a'.repeat(40);
    const broken = [
      '',
      'not a commit at all',
      '\u001d',
      `${hash}\u001fnot-a-parent\u001fa\u001fa@b\u001f1\u001f2\u001fsubject\u001dbody`,
    ];
    for (const record of broken) {
      const parsed = parseCommitDetail(record);
      expect(parsed.ok, JSON.stringify(record)).toBe(false);
      if (!parsed.ok) expect(parsed.error.length).toBeGreaterThan(0);
    }

    // Byte mutations of a real record: the parser must answer, not crash.
    const raw = (
      await git(where, 'log', '-z', '--max-count=1', `--format=${DETAIL_FORMAT}`, normal)
    ).stdout;
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat({ max: 4000 }), fc.integer({ min: 0, max: 255 })), {
          maxLength: 16,
        }),
        (mutations) => {
          const bytes = Buffer.from(raw, 'utf8');
          if (bytes.length === 0) return true;
          for (const [position, value] of mutations) bytes[position % bytes.length] = value;
          const parsed = parseCommitDetail(bytes.toString('utf8'));
          return typeof parsed.ok === 'boolean';
        },
      ),
      { numRuns: 300 },
    );
  });

  it('[I4] a separator inside a free-form field is not a field boundary', () => {
    const hash = 'b'.repeat(40);
    // `%s` and `%b` both contain FIELD_SEP; only DETAIL_SEP ends the head. A parser that
    // split the whole record on FIELD_SEP would invent fields here.
    const record = `${hash}\u001f\u001fname\u001femail\u001f1\u001f2\u001fsub\u001fject\u001dbody\u001fline`;
    const parsed = parseCommitDetail(record);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.subject).toBe('sub\u001fject');
      expect(parsed.value.body).toBe('body\u001fline');
    }
  });
});
