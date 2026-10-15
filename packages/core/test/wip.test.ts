import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { workingTreeNode } from '../src/graph/wip.ts';
import { openRepo, readStatus } from '../src/repo.ts';
import { v1Counts } from './support/crosscheck.ts';
import { type FixtureSet, git, makeFixtures } from './support/fixtures.ts';

/**
 * The WIP node's numbers, checked against `git status --porcelain=v1` rather than against our
 * own parse: v1 spells an unmerged path as one of seven XY pairs and an untracked one as `??`,
 * so a counting rule written from the v2 alphabet alone would pass here only by luck.
 */
let set: FixtureSet;

beforeAll(async () => {
  set = await makeFixtures();
});

afterAll(async () => {
  await set.cleanup();
});

describe('the working tree as a node of the graph', () => {
  it('[I5] the counts agree with `git status --porcelain=v1`, on every fixture', async () => {
    const checked: string[] = [];
    for (const fixture of set.fixtures) {
      const node = workingTreeNode(await readStatus(await openRepo(fixture.root)));
      const counts = await v1Counts(fixture.root);
      expect({
        fixture: fixture.name,
        staged: node.staged,
        unstaged: node.unstaged,
        conflicted: node.conflicted,
        untracked: node.untracked,
        dirty: node.dirty,
      }).toEqual({ fixture: fixture.name, ...counts });
      checked.push(fixture.name);
    }
    // A loop over an empty list passes. Name the fixtures it actually read, and require the two
    // states that make the counting rules different from each other.
    expect(checked).toContain('mixed');
    expect(checked).toContain('conflicted');
  });

  it('[I5] the node sits on the commit HEAD points at, or on nothing when there is none', async () => {
    const heads: string[] = [];
    for (const fixture of set.fixtures) {
      const node = workingTreeNode(await readStatus(await openRepo(fixture.root)));
      // `--verify --quiet` turns an unborn head into an exit code and an empty stdout, which is
      // the same answer the parser has to give: a repository with no commit to sit on.
      const head = await git(fixture.root, 'rev-parse', '--verify', '--quiet', 'HEAD');
      expect({ fixture: fixture.name, on: node.on }).toEqual({
        fixture: fixture.name,
        on: head.code === 0 ? head.stdout.trim() : null,
      });
      heads.push(node.on === null ? 'none' : 'commit');
    }
    expect(heads).toContain('none');
    expect(heads).toContain('commit');
  });
});
