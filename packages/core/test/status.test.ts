import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePendingOperation, parseStatus } from '../src/git/status.ts';
import { openRepo, readStatus } from '../src/repo.ts';
import { findStatusMismatches } from './support/crosscheck.ts';
import { type FixtureSet, git, makeFixtures } from './support/fixtures.ts';

let set: FixtureSet;

beforeAll(async () => {
  set = await makeFixtures();
});

afterAll(async () => {
  await set.cleanup();
});

describe('a real repository, read two ways', () => {
  it('[I5] the parser agrees with git on every fixture', async () => {
    const report: string[] = [];
    for (const fixture of set.fixtures) {
      const repo = await openRepo(fixture.root);
      const state = await readStatus(repo);
      const mismatches = await findStatusMismatches(fixture.root, state);
      for (const mismatch of mismatches) {
        report.push(
          `${fixture.name}: ${mismatch.what} expected ${mismatch.expected} got ${mismatch.actual}`,
        );
      }
    }
    expect(report).toEqual([]);
  });

  it('[I4] no record is silently dropped', async () => {
    for (const fixture of set.fixtures) {
      const repo = await openRepo(fixture.root);
      const state = await readStatus(repo);
      const raw = await git(
        fixture.root,
        'status',
        '--porcelain=v2',
        '--branch',
        '--untracked-files=all',
        '-z',
      );
      const records = raw.stdout.split('\u0000');
      if (records[records.length - 1] === '') records.pop();
      // A rename record owns the record that follows it, so it is not a second entry.
      const entryRecords = records.filter((record) => !record.startsWith('# '));
      const renames = records.filter((record) => record.startsWith('2 ')).length;
      expect(state.entries.length, `${fixture.name} entry count`).toBe(
        entryRecords.length - renames,
      );
      // Nothing invented and nothing lost: the raw line is on the entry.
      for (const entry of state.entries) {
        expect(entry.raw.startsWith('# ')).toBe(false);
        expect(entry.raw.length).toBeGreaterThan(0);
      }
    }
  });

  it('[I4] a broken record is a value, never an exception', () => {
    const broken = [
      '',
      '# branch.oid',
      '1',
      '1 X',
      '1 XX N... 100644 100644 100644 aaa bbb',
      '2 XX N... 100644 100644 100644 aaa bbb R100',
      'u XX',
      'z something',
      '# branch.ab +1',
    ];
    for (const record of broken) {
      const parsed = parseStatus(`${record}\u0000`);
      if (parsed.ok) {
        // A header-only input is a legitimate empty state; anything else is not.
        expect(record.startsWith('# ')).toBe(true);
      } else {
        expect(parsed.error).toBeTypeOf('string');
        expect(parsed.error.length).toBeGreaterThan(0);
      }
    }
  });
});
describe('the operation under way, read from git itself', () => {
  it('[I5] a conflicted merge reports the operation the merge head names', async () => {
    const conflicted = set.fixtures.find((fixture) => fixture.name === 'conflicted');
    if (conflicted === undefined) throw new Error('the conflicted fixture is missing');
    // The merge was left failed on purpose, so MERGE_HEAD exists: the ref, not our reading
    // of the porcelain output, is what the answer is compared against.
    const mergeHead = await git(conflicted.root, 'rev-parse', '--verify', '-q', 'MERGE_HEAD');
    expect(mergeHead.code).toBe(0);
    const state = await readStatus(await openRepo(conflicted.root));
    expect(state.pending).toBe('merge');
    // A conflicted repository still names the branch it is merging onto.
    expect(state.head.kind).toBe('branch');
    const unmerged = state.entries.filter((entry) => entry.kind === 'unmerged');
    expect(unmerged.map((entry) => entry.path)).toEqual(['shared.txt']);
  });

  it('[I5] a repository with no operation under way reports none', async () => {
    for (const name of ['clean', 'mixed', 'history', 'diffable', 'upstream', 'nasty']) {
      const fixture = set.fixtures.find((candidate) => candidate.name === name);
      if (fixture === undefined) throw new Error(`the ${name} fixture is missing`);
      // Nothing has been started in any of them: git has no ref to answer with.
      for (const ref of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REBASE_HEAD']) {
        const probe = await git(fixture.root, 'rev-parse', '--verify', '-q', ref);
        expect(probe.code, `${name} ${ref}`).not.toBe(0);
      }
      const state = await readStatus(await openRepo(fixture.root));
      expect(state.pending, name).toBeNull();
    }
  });

  it('[I5] the unborn repository is unborn and has no operation under way', async () => {
    const unborn = set.fixtures.find((fixture) => fixture.name === 'unborn');
    if (unborn === undefined) throw new Error('the unborn fixture is missing');
    const state = await readStatus(await openRepo(unborn.root));
    expect(state.head.kind).toBe('unborn');
    expect(state.pending).toBeNull();
  });
});

describe('the resolver that maps the three reads onto one state', () => {
  it('[I4] it is total: no output is nothing under way, and nothing throws', () => {
    const oid = 'a'.repeat(40);
    expect(parsePendingOperation({})).toBeNull();
    expect(
      parsePendingOperation({ MERGE_HEAD: '', CHERRY_PICK_HEAD: '', REBASE_HEAD: '' }),
    ).toBeNull();
    expect(parsePendingOperation({ MERGE_HEAD: `${oid}\n` })).toBe('merge');
    expect(parsePendingOperation({ CHERRY_PICK_HEAD: `${oid}\n` })).toBe('cherry-pick');
    expect(parsePendingOperation({ REBASE_HEAD: `${oid}\n` })).toBe('rebase');
    // A rebase leaves MERGE_HEAD behind as well, so the first one to resolve has to win.
    expect(
      parsePendingOperation({ MERGE_HEAD: oid, CHERRY_PICK_HEAD: oid, REBASE_HEAD: oid }),
    ).toBe('merge');
    expect(parsePendingOperation({ CHERRY_PICK_HEAD: oid, REBASE_HEAD: oid })).toBe('cherry-pick');
    // The shape is data, so an odd read is an answer rather than an exception.
    expect(parsePendingOperation({ MERGE_HEAD: '\n' })).toBeNull();
  });
});
