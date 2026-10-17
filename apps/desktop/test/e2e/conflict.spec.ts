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
    await expect(page.locator('[data-testid=conflict-base]')).toHaveText('the common line');
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

/**
 * A conflict with two regions: the same two lines changed on both branches, far enough apart that
 * git prints them separately. With one region, a screen resolving the wrong one would look correct.
 */
async function twoRegionConflict(): Promise<string> {
  const twenty = (at: string): string => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    lines[2] = `${at} at 3`;
    lines[17] = `${at} at 18`;
    return `${lines.join('\n')}\n`;
  };
  const repo = await makeRepo();
  await writeIn(repo, 'f.txt', twenty('line'));
  await commit(repo, 'twenty lines');
  await git(repo, ['checkout', '--quiet', '-b', 'other']);
  await writeIn(repo, 'f.txt', twenty('theirs'));
  await commit(repo, 'the other branch changes both');
  await git(repo, ['checkout', '--quiet', 'main']);
  await writeIn(repo, 'f.txt', twenty('ours'));
  await commit(repo, 'this branch changes both');
  await git(repo, ['merge', 'other']).catch(() => '');
  expect(await git(repo, ['status', '--porcelain=v2'])).toContain('u UU');
  return repo;
}

test('a conflict is resolved region by region, and the list renumbers as it goes', async () => {
  const repo = await twoRegionConflict();
  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    await page.locator('[data-testid=entry-item][data-path="f.txt"]').click();
    const rows = page.locator('[data-testid=conflict-region]');
    await expect(rows).toHaveCount(2);

    // Wait for what the panel is still reading before the picture: the regions and the three
    // versions are separate reads, and a screenshot taken between them shows "loading…" where the
    // feature is.
    await expect(page.locator('[data-testid=conflict-theirs] pre')).toContainText('theirs at 3');

    const screenshot = resolve(import.meta.dirname, '..', '..', 'reports', 'regions.png');
    await mkdir(dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot });
    console.log(`screenshot: ${screenshot}`);

    const onDisk = async (): Promise<string[]> =>
      (await readFile(resolve(repo, 'f.txt'), 'utf8')).split('\n');

    // The first region, resolved with text typed here rather than with either side.
    await rows.nth(0).locator('[data-testid=region-edit]').click();
    await page.locator('[data-testid=region-text]').fill('the merged line');
    await page.locator('[data-testid=region-save]').click();
    await expect.poll(async () => (await onDisk())[2]).toBe('the merged line');

    // Resolving one renumbers the rest, so the region that is left is the first one again — which
    // is the assertion a screen that kept its own list would fail.
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0).locator('[data-testid=region-sides]')).toContainText('theirs at 18');

    await rows.nth(0).locator('[data-testid=region-theirs]').click();
    await expect.poll(async () => (await onDisk())[17]).toBe('theirs at 18');
    await expect(rows).toHaveCount(0);
    expect((await onDisk()).join('\n')).not.toContain('<<<<<<<');

    // Resolving the text is not resolving the conflict: `git add` is.
    expect(await git(repo, ['status', '--porcelain=v2'])).toContain('u UU');
    await page
      .locator('li', { has: page.locator('[data-testid=entry-item][data-path="f.txt"]') })
      .getByRole('button', { name: 'resolve' })
      .click();
    await expect.poll(() => git(repo, ['status', '--porcelain=v2'])).not.toContain('u UU');
  } finally {
    await closeApp(handle);
    await rm(repo, { recursive: true, force: true });
  }
});

/**
 * The editor: the two sides to read, and the column in the middle to write.
 *
 * The assertion is about the file and about git, not about the widget: what is written is what the
 * textarea held, and the path stays unmerged until it is added — writing the text is not resolving
 * the conflict, and a screen that hid that difference would be lying about which step is left.
 */
test('the two sides are beside an editable result, and writing it changes the file', async () => {
  const repo = await conflictedRepo();
  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    await page.locator('[data-testid=entry-item][data-path="base.txt"]').click();

    // The result starts from ours, which is the choice being made nine times out of ten, and the two
    // other columns are there to be read.
    const result = page.locator('[data-testid=conflict-result-text]');
    await expect(result).toHaveValue('what this branch says\n');
    await expect(page.locator('[data-testid=conflict-ours] pre')).toContainText(
      'what this branch says',
    );
    await expect(page.locator('[data-testid=conflict-theirs] pre')).toContainText(
      'what the other branch says',
    );

    await result.fill('what the two of them agree it should say\n');
    await page.locator('[data-testid=conflict-save]').click();

    await expect
      .poll(async () => await readFile(resolve(repo, 'base.txt'), 'utf8'))
      .toBe('what the two of them agree it should say\n');
    // Still unmerged: the file reads right and the conflict is not resolved until it is added.
    expect(await git(repo, ['status', '--porcelain=v2'])).toContain('u UU');

    const screenshot = resolve(import.meta.dirname, '..', '..', 'reports', 'editor.png');
    await mkdir(dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot });
    console.log(`screenshot: ${screenshot}`);
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
