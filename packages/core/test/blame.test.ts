import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blamedCommits, parseBlame } from '../src/git/blame.ts';
import { openRepo, readBlame } from '../src/repo.ts';
import { git } from './support/fixtures.ts';

/**
 * Blame: where each line of a file came from.
 *
 * The fixture writes a file in two commits by two authors and then *appends* a line, so the answer has
 * to be per line rather than per file, which is the whole point of the command. Every assertion about
 * which commit a line came from is cross-checked against the same question asked another way —
 * `git blame --porcelain`, a different format, and `git log -L`, which walks the history of one line
 * range — because a parser confirmed by its own output is a parser nobody checked.
 */
let root = '';
let beside = '';
const FILE = 'a.txt';
const plain = promisify(execFile);

beforeEach(async () => {
  beside = await mkdtemp(join(tmpdir(), 'orbitree-blame-'));
  root = join(beside, 'repo');
  await git(beside, 'init', '-b', 'main', '--quiet', root);
  await git(root, 'config', 'core.autocrlf', 'false');
  await git(root, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(root, FILE), 'first\nsecond\n', 'utf8');
  await git(root, 'add', '-A');
  await git(root, 'commit', '--quiet', '-m', 'the first two lines');
  // A second author, so "who wrote this line" has two possible answers. The environment is set here
  // rather than with `-c user.name`, because the fixture helper's environment would win over a config
  // value — the same reason the helper sets it there in the first place.
  await writeFile(join(root, FILE), 'first\nsecond\nthird\n', 'utf8');
  await git(root, 'add', '-A');
  await plain('git', ['commit', '--quiet', '-m', 'a third line'], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Second Author',
      GIT_AUTHOR_EMAIL: 'second@example.invalid',
      GIT_COMMITTER_NAME: 'Second Author',
      GIT_COMMITTER_EMAIL: 'second@example.invalid',
    },
  });
});

afterEach(async () => {
  await rm(beside, { recursive: true, force: true });
});

describe('the blame of a file', () => {
  it('[I5] each line names the commit that wrote it, and git agrees line by line', async () => {
    const lines = await readBlame(await openRepo(root), { path: FILE });
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.content)).toEqual(['first', 'second', 'third']);
    expect(lines.map((line) => line.line)).toEqual([1, 2, 3]);

    // Two commits, and the first two lines belong to the first of them: git's own answer for which
    // commit wrote the file, and which one wrote it before that.
    const earlier = (
      await git(root, 'log', '--format=%H', '--skip=1', '-1', '--', FILE)
    ).stdout.trim();
    const latest = (await git(root, 'log', '--format=%H', '-1', '--', FILE)).stdout.trim();
    expect(lines[0]?.oid).toBe(earlier);
    expect(lines[1]?.oid).toBe(earlier);
    expect(lines[2]?.oid).toBe(latest);
    expect(lines[0]?.author).toBe('Fixture Author');
    expect(lines[2]?.author).toBe('Second Author');
    expect(lines[2]?.authorMail).toBe('second@example.invalid');
    expect(blamedCommits(lines)).toEqual([earlier, latest]);
    // The first two lines come from the repository's first commit, which git marks as a boundary —
    // there is no earlier history to walk — and the third does not. Both directions, because a parser
    // that set `boundary` on everything would pass a test that only checked one.
    expect(lines[0]?.boundary).toBe(true);
    expect(lines[1]?.boundary).toBe(true);
    expect(lines[2]?.boundary).toBe(false);

    // Cross-checked against the same question in another format: `--porcelain` groups the metadata,
    // so a disagreement is the parser's and not git's.
    const other = await git(root, 'blame', '--porcelain', '--', FILE);
    const oids = other.stdout
      .split('\n')
      .map((line) => /^([0-9a-f]{40}) \d+ \d+/.exec(line)?.[1])
      .filter(
        (oid): oid is string =>
          oid !== undefined && oid !== '0000000000000000000000000000000000000000',
      );
    expect(oids).toHaveLength(3);
    // The second and third lines have their metadata omitted in `--porcelain` (the same commit as the
    // line before), which is exactly what `--line-porcelain` avoids.
    expect(oids[0]).toBe(lines[0]?.oid);

    // And the content is the file's own content: blame of an unmodified file is the file.
    const onDisk = (await readFile(join(root, FILE), 'utf8')).split('\n').slice(0, 3);
    expect(lines.map((line) => line.content)).toEqual(onDisk);
  });

  it('[I5] a revision blames the file as it was there', async () => {
    // The same file one commit earlier has two lines, and the third line does not exist yet: the
    // question is about a file at a revision, not only about the one on disk.
    const lines = await readBlame(await openRepo(root), { path: FILE, rev: 'HEAD~1' });
    expect(lines.map((line) => line.content)).toEqual(['first', 'second']);
    expect(lines.every((line) => line.author === 'Fixture Author')).toBe(true);

    // Cross-checked with `git log -L`, which walks one line range through the history: the commits it
    // names are the commits blame names for those very lines.
    const walked = await git(root, 'log', '-L', '1,2:a.txt', '--format=%H');
    for (const oid of blamedCommits(lines)) expect(walked.stdout).toContain(oid);
  });

  it('[I4] a block it cannot read is a value, and an unknown header is kept', () => {
    const header = 'a'.repeat(40);
    // A tab with no header before it, and a header with no content line.
    expect(parseBlame('\tjust a line\n').ok).toBe(false);
    expect(parseBlame(`${header} 1 1\nsummary something\n`).ok).toBe(false);
    expect(parseBlame(`${header} 1 1 1\nauthor\n`).ok).toBe(false);

    // A key this version does not name stays in `raw`: git adds metadata, and a newer git's output
    // should be readable by an older product rather than fatal.
    const parsed = parseBlame(`${header} 7 3 1\nauthor Someone\nfuture thing\n\tthe line\n`);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value[0]?.line).toBe(3);
    expect(parsed.ok && parsed.value[0]?.originalLine).toBe(7);
    expect(parsed.ok && parsed.value[0]?.raw).toContain('future thing');
    expect(parsed.ok && parsed.value[0]?.authorTime).toBe(0);
    // A boundary commit is marked by a `^` on the header, which is how the first commit of a shallow
    // read is spelled.
    const boundary = parseBlame(`^${header} 1 1 1\nboundary\n\tthe first line\n`);
    expect(boundary.ok && boundary.value[0]?.boundary).toBe(true);
  });
});
