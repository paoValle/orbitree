import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countConflictStarts, parseConflictRegions } from '../src/git/conflict.ts';
import { execute } from '../src/git/exec.ts';
import { git } from './support/fixtures.ts';

/**
 * Resolving a conflict one region at a time.
 *
 * The patch is built from a read of the file, so what a caller supplies is a choice and — for
 * `custom` — some lines. These tests are about the two things that can go wrong with that: the
 * patch applied to the wrong lines, and a caller's text escaping the region it was meant for.
 *
 * The conflict itself is made by the real `git` binary, and two changes far apart make two regions:
 * with one, a patch built from the wrong region would pass.
 */
let root = '';

const twentyLines = { ours: 'ours', theirs: 'theirs', base: 'line' } as const;

const write = async (side: 'base' | 'ours' | 'theirs'): Promise<void> => {
  const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
  if (side !== 'base') {
    lines[2] = `${twentyLines[side]} at 3`;
    lines[17] = `${twentyLines[side]} at 18`;
  }
  await writeFile(join(root, 'f.txt'), `${lines.join('\n')}\n`, 'utf8');
};

const lines = async (): Promise<string[]> =>
  (await readFile(join(root, 'f.txt'), 'utf8')).split('\n').slice(0, -1);

/** A repository stopped in the middle of a two-region conflict, made by git itself. */
async function conflicted(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'orbitree-conflict-'));
  await git(root, 'init', '-b', 'main', '--quiet');
  await git(root, 'config', 'core.autocrlf', 'false');
  await git(root, 'config', 'commit.gpgsign', 'false');
  await write('base');
  await git(root, 'add', '-A');
  await git(root, 'commit', '--quiet', '-m', 'base');
  await git(root, 'checkout', '--quiet', '-b', 'other');
  await write('theirs');
  await git(root, 'commit', '--quiet', '-am', 'theirs');
  await git(root, 'checkout', '--quiet', 'main');
  await write('ours');
  await git(root, 'commit', '--quiet', '-am', 'ours');
  await git(root, 'merge', 'other');
  expect(countConflictStarts(await lines())).toBe(2);
}

const resolve = (region: number, take: 'ours' | 'theirs' | 'both' | 'custom', content?: string) =>
  execute(
    {
      op: 'resolve-conflict',
      path: 'f.txt',
      region,
      take,
      ...(content === undefined ? {} : { content }),
    },
    { cwd: root },
  );

beforeEach(conflicted);

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('the conflict regions of a file', () => {
  it('[I4] reads the regions git wrote, and keeps both sides of each', async () => {
    const regions = parseConflictRegions(await lines());
    expect(regions).toHaveLength(2);
    expect(regions[0]?.ours).toEqual(['ours at 3']);
    expect(regions[0]?.theirs).toEqual(['theirs at 3']);
    expect(regions[1]?.ours).toEqual(['ours at 18']);
    expect(regions[1]?.theirs).toEqual(['theirs at 18']);
    // The second region comes after the first, which is what a caller counting them assumes.
    expect(regions[1]?.start).toBeGreaterThan(regions[0]?.end ?? 0);
  });
});

describe('resolving one region', () => {
  it('[I5] replaces that region only, and leaves the other one in conflict', async () => {
    const result = await resolve(0, 'theirs');
    expect(result.exitCode).toBe(0);

    const after = await lines();
    expect(after[2]).toBe('theirs at 3');
    // The other region is untouched, markers and all, and git still calls the path unmerged:
    // resolving the text is not resolving the conflict, which is what `git add` says.
    expect(countConflictStarts(after)).toBe(1);
    expect(after).toContain('ours at 18');
    expect(await git(root, 'status', '--porcelain=v2')).toMatchObject({ code: 0 });
    expect((await git(root, 'status', '--porcelain=v2')).stdout).toContain('u UU');
  });

  it('[I5] the remaining regions renumber, so the next call is region 0 again', async () => {
    await resolve(0, 'theirs');
    const before = parseConflictRegions(await lines());
    // Asking for region 1 now names a region that is not there: the index counts the regions of
    // the file as it is, and a caller that assumed otherwise would resolve the wrong one.
    await expect(resolve(1, 'ours')).rejects.toThrow(/1 conflict region/);

    const result = await resolve(0, 'ours');
    expect(result.exitCode).toBe(0);
    const after = await lines();
    expect(after[2]).toBe('theirs at 3');
    expect(after[17]).toBe('ours at 18');
    expect(countConflictStarts(after)).toBe(0);
    expect(before).toHaveLength(1);
  });

  it('takes both sides when both are wanted', async () => {
    const result = await resolve(0, 'both');
    expect(result.exitCode).toBe(0);
    const after = await lines();
    expect(after.slice(2, 4)).toEqual(['ours at 3', 'theirs at 3']);
    expect(countConflictStarts(after)).toBe(1);
  });

  it('takes a caller’s own lines for a region, and nothing else', async () => {
    // A `custom` resolution whose text is shaped like a patch header. Every added line is prefixed
    // in the patch this builds, so these are three added lines and nothing more: the file's other
    // lines are untouched, and no second file is named.
    const result = await resolve(0, 'custom', '--- a/etc/passwd\n@@ -1 +1 @@\n+root::0:0');
    expect(result.exitCode).toBe(0);

    const after = await lines();
    expect(after.slice(2, 5)).toEqual(['--- a/etc/passwd', '@@ -1 +1 @@', '+root::0:0']);
    // The lines around it are the file's own, and the region's other side is gone.
    expect(after.slice(0, 2)).toEqual(['line 1', 'line 2']);
    expect(after).toContain('line 20');
    expect(after).not.toContain('ours at 3');
    expect(countConflictStarts(after)).toBe(1);
  });

  it('refuses a region that is not there, and a file that is not in conflict', async () => {
    await expect(resolve(9, 'ours')).rejects.toThrow(/2 conflict regions/);

    // Empty text is no lines, so resolving a region to nothing deletes it: the markers and both
    // sides go, and the file is left with its other lines.
    expect((await resolve(0, 'custom', '')).exitCode).toBe(0);
    const after = await lines();
    expect(after).not.toContain('ours at 3');
    expect(after).not.toContain('theirs at 3');
    expect(after.slice(0, 2)).toEqual(['line 1', 'line 2']);
    expect(countConflictStarts(after)).toBe(1);

    // And a file with no conflict left has no region to resolve, whatever it is asked for.
    await resolve(0, 'ours');
    expect(countConflictStarts(await lines())).toBe(0);
    await expect(resolve(0, 'ours')).rejects.toThrow(/0 conflict regions/);
  });
});
