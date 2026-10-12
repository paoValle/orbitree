import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseStashList } from '../src/git/stash.ts';
import { type FixtureSet, git, makeFixtures } from './support/fixtures.ts';

/**
 * The stash list is read, never written. Applying or dropping one is a P2 action, and until
 * then the honest thing is to be able to see it.
 */
let set: FixtureSet;
let where = '';

beforeAll(async () => {
  set = await makeFixtures();
  where = set.fixtures.find((fixture) => fixture.name === 'nested')?.root ?? '';
});

afterAll(async () => {
  await set?.cleanup();
});

describe('a stash, read', () => {
  it('[I5] the stash list agrees with git, and an empty one is an empty list', async () => {
    const { readStash, openRepo } = await import('../src/repo.ts');
    const repo = await openRepo(where);
    const stashes = await readStash(repo);

    const selectors = (await git(where, 'stash', 'list', '--format=%gd')).stdout
      .split('\n')
      .filter((line) => line !== '');
    expect(stashes.map((entry) => entry.selector)).toEqual(selectors);
    expect(stashes.length).toBeGreaterThan(0);

    // The subject is what git printed for that selector, not the selector again.
    for (const entry of stashes) {
      const subject = (await git(where, 'log', '-1', '--format=%s', entry.selector)).stdout;
      expect(entry.subject, entry.selector).toBe(subject.trim());
    }

    // A repository with nothing stashed answers with an empty list, which is a state.
    const cleanRoot = (set.fixtures[0] ?? { root: '' }).root;
    expect(await readStash(await openRepo(cleanRoot))).toEqual([]);
  });

  it('[I4] a line that is not a stash line is a value, never an exception', async () => {
    const broken = [
      '',
      'not a stash line\n',
      'stash@{0}\n',
      'stash@{0}|' + 'a'.repeat(40) + '|not a timestamp|subject\n',
      'stash@{0}|' + 'z'.repeat(40) + '|1|subject\n',
    ];
    for (const record of broken) {
      const parsed = parseStashList(record);
      if (record === '') expect(parsed.ok).toBe(true);
      else expect(parsed.ok, record).toBe(false);
    }

    const raw = (await git(where, 'stash', 'list', '--format=%gd\u001f%H\u001f%ct\u001f%s')).stdout;
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat({ max: 400 }), fc.integer({ min: 0, max: 255 })), {
          maxLength: 16,
        }),
        (mutations) => {
          const bytes = Buffer.from(raw, 'utf8');
          if (bytes.length === 0) return true;
          for (const [position, value] of mutations) bytes[position % bytes.length] = value;
          return typeof parseStashList(bytes.toString('utf8')).ok === 'boolean';
        },
      ),
      { numRuns: 200 },
    );
  });
});
