import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseStatus } from '../src/git/status.ts';
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
