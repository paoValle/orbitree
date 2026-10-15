import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { closeApp, git, launchApp, mainWindow, makeRepo, writeIn } from './support.ts';

/**
 * Discarding a change is the one action in the working tree that destroys work, so it is the one
 * that has to ask first — and the assertion that matters is the one about what git says afterwards,
 * not about what the sheet looked like.
 *
 * A tracked path is restored; a path git has never tracked is removed by `clean`, because
 * `restore` is a question about a tracked path and does nothing to an untracked one.
 */
test('a change is discarded only after a reason, and the file goes back to HEAD', async () => {
  const repo = await makeRepo({ base: 'the committed line\n' });
  await writeIn(repo, 'base.txt', 'a change nobody has committed\n');
  await writeIn(repo, 'never-added.txt', 'a file git has never seen\n');
  const before = await git(repo, ['rev-parse', 'HEAD']);

  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    await expect(page.locator('[data-testid=entry-item][data-path="base.txt"]')).toBeVisible();

    // The discard button is the row's sibling rather than its child — a button cannot hold a
    // button — so the row is named by its file and the button is found inside that row.
    const rowFor = (path: string) =>
      page
        .locator('li', { has: page.locator(`[data-testid=entry-item][data-path="${path}"]`) })
        .locator('[data-testid=discard-button]');

    // The tracked file: the sheet opens, and it refuses to run without a reason.
    await rowFor('base.txt').click();
    const sheet = page.locator('[role=dialog]');
    await expect(sheet).toBeVisible();
    await expect(page.locator('[placeholder=reason]')).toBeVisible();
    await expect(sheet.locator('button.danger')).toBeDisabled();
    // Nothing has run yet: the file on disk still holds the change. Read from the file rather than
    // from `git status`, which lists a path and never a content.
    const onDisk = () => readFile(resolve(repo, 'base.txt'), 'utf8');
    expect(await onDisk()).toBe('a change nobody has committed\n');

    await page.locator('[placeholder=reason]').fill('the change was a mistake');
    await sheet.locator('button.danger').click();
    await expect.poll(onDisk).toBe('the committed line\n');
    expect(await git(repo, ['status', '--porcelain=v2'])).not.toContain('base.txt');

    // The untracked file: `clean` with the path, through the same sheet, and the file is gone.
    await rowFor('never-added.txt').click();
    await expect(sheet).toBeVisible();
    await page.locator('[placeholder=reason]').fill('the file was a mistake too');
    await sheet.locator('button.danger').click();
    await expect.poll(() => git(repo, ['status', '--porcelain=v2'])).not.toContain('never-added');

    // The picture is taken once the *window* says the tree is clean, not once git does: the app's
    // own refresh is two round trips behind a change it just made, and a screenshot taken in
    // between shows a node that is telling the truth about a moment that has passed.
    await expect(page.locator('[data-testid=wip-row]')).toContainText('clean');

    // The repository itself did not move: discarding a working-tree change is not a commit.
    expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(before);

    const screenshot = resolve(import.meta.dirname, '..', '..', 'reports', 'discard.png');
    await mkdir(dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot });
    console.log(`screenshot: ${screenshot}`);
  } finally {
    await closeApp(handle);
    await rm(repo, { recursive: true, force: true });
  }
});
