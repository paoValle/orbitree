import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { closeApp, commit, git, launchApp, mainWindow, makeRepo, writeIn } from './support.ts';

/**
 * The conflict screen: the three versions git is holding for a path, one side taken, and the merge
 * given up on.
 *
 * Every assertion is about what git says afterwards or about the file on disk — the panel is the
 * thing under test. A merge that conflicts exits non-zero, which is not a failure here: it is the
 * state the screen exists for.
 */
async function conflictedRepo(): Promise<string> {
  const repo = await makeRepo({ base: 'the common line\n' });
  await git(repo, ['checkout', '--quiet', '-b', 'other']);
  await writeIn(repo, 'base.txt', 'what the other branch says\n');
  await commit(repo, 'the other branch changes the line');
  await git(repo, ['checkout', '--quiet', 'main']);
  await writeIn(repo, 'base.txt', 'what this branch says\n');
  await commit(repo, 'this branch changes it too');
  await git(repo, ['merge', 'other']).catch(() => '');
  // The merge really conflicted: a repository that merged cleanly would make every assertion below
  // pass for the wrong reason.
  expect(await git(repo, ['status', '--porcelain=v2'])).toContain('u UU');
  return repo;
}

test('a conflicted path shows its three versions, takes a side, and the merge is given up on', async () => {
  const repo = await conflictedRepo();
  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    const row = page.locator('li', {
      has: page.locator('[data-testid=entry-item][data-path="base.txt"]'),
    });
    await expect(row.locator('[data-testid=take-ours]')).toBeVisible();
    await expect(row.locator('[data-testid=take-theirs]')).toBeVisible();

    // The three versions, read from the index stages rather than from the file with its markers.
    await page.locator('[data-testid=entry-item][data-path="base.txt"]').click();
    await expect(page.locator('[data-testid=conflict]')).toBeVisible();
    await expect(page.locator('[data-testid=conflict-base] pre')).toHaveText('the common line');
    await expect(page.locator('[data-testid=conflict-ours] pre')).toContainText(
      'what this branch says',
    );
    await expect(page.locator('[data-testid=conflict-theirs] pre')).toContainText(
      'what the other branch says',
    );

    const screenshot = resolve(import.meta.dirname, '..', '..', 'reports', 'conflict.png');
    await mkdir(dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot });
    console.log(`screenshot: ${screenshot}`);

    // Taking a side writes that side and leaves the conflict in the index: git still calls the path
    // unmerged, which is what makes taking a side safe to do and undo.
    await row.locator('[data-testid=take-theirs]').click();
    await expect
      .poll(async () => (await readFile(resolve(repo, 'base.txt'), 'utf8')).trim())
      .toBe('what the other branch says');
    expect(await git(repo, ['status', '--porcelain=v2'])).toContain('u UU');

    // Giving up puts the branch back where it was, conflict and all.
    await page.locator('[data-testid=merge-abort]').click();
    await expect
      .poll(() => git(repo, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).catch(() => ''))
      .toBe('');
    await expect
      .poll(async () => (await readFile(resolve(repo, 'base.txt'), 'utf8')).trim())
      .toBe('what this branch says');
  } finally {
    await closeApp(handle);
    await rm(repo, { recursive: true, force: true });
  }
});

test('resolving a conflict is `git add`, under git’s own word for it', async () => {
  const repo = await conflictedRepo();

  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    const row = page.locator('li', {
      has: page.locator('[data-testid=entry-item][data-path="base.txt"]'),
    });
    // The conflicted section's own button says what it does, and the command behind it is `add`.
    await row.getByRole('button', { name: 'resolve' }).click();

    await expect.poll(() => git(repo, ['status', '--porcelain=v2'])).not.toContain('u UU');
    await expect(page.locator('[data-testid=activity-argv]').first()).toContainText(
      'add -- base.txt',
    );
  } finally {
    await closeApp(handle);
    await rm(repo, { recursive: true, force: true });
  }
});
