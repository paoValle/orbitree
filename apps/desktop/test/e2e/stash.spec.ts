import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { closeApp, git, launchApp, mainWindow, makeRepo, writeIn } from './support.ts';

/**
 * What a person does with a stash: look at it, put it back, and only then throw it away.
 *
 * The assertions are git's own answers and the file on disk, not the card's: the card is the thing
 * under test. The interesting difference is between `apply` and `pop` — both put the work back, and
 * only one of them also drops the stash — so both are asserted, in that order, with `git stash
 * list` read after each.
 */
test('a stash is shown, applied without being dropped, and then dropped after a reason', async () => {
  const repo = await makeRepo({ base: 'the committed line\n' });
  await writeIn(repo, 'base.txt', 'the line a stash is holding\n');
  await git(repo, ['stash', 'push', '--quiet', '-m', 'work set aside']);
  const stashOid = (await git(repo, ['stash', 'list', '--format=%H'])).trim();

  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    const entry = page.locator('[data-testid=stash-entry]').first();
    await expect(entry).toBeVisible();
    await expect(entry).toContainText('work set aside');

    // Looking at it changes nothing, which is the point of a preview.
    await entry.locator('[data-testid=stash-show]').click();
    const patch = page.locator('[data-testid=stash-patch]');
    await expect(patch).toBeVisible();
    await expect(patch).toContainText('the line a stash is holding');
    expect(await git(repo, ['stash', 'list', '--format=%H'])).toBe(stashOid.trim());
    expect((await readFile(resolve(repo, 'base.txt'), 'utf8')).trim()).toBe('the committed line');

    // `apply` puts it back and keeps the stash: the work exists twice for as long as it takes to
    // decide, which is why it does not ask for a reason.
    await entry.locator('[data-testid=stash-apply]').click();
    await expect
      .poll(async () => (await readFile(resolve(repo, 'base.txt'), 'utf8')).trim())
      .toBe('the line a stash is holding');
    expect(await git(repo, ['stash', 'list', '--format=%H'])).toBe(stashOid.trim());

    // `drop` destroys it, so it is the one that asks — and it does not run without a reason.
    await page
      .locator('[data-testid=stash-entry]')
      .first()
      .locator('[data-testid=stash-drop]')
      .click();
    const sheet = page.locator('[role=dialog]');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('button.danger')).toBeDisabled();
    expect(await git(repo, ['stash', 'list', '--format=%H'])).toBe(stashOid.trim());
    await page.locator('[placeholder=reason]').fill('the work is already back in the tree');
    await sheet.locator('button.danger').click();
    await expect.poll(() => git(repo, ['stash', 'list', '--format=%H'])).toBe('');

    // The picture is taken once the *window* agrees, not once git does: the app's refresh is two
    // round trips behind a change it just made, and a screenshot taken in between shows a stash
    // row and a graph node for a stash that no longer exists.
    await expect(page.locator('[data-testid=stash-entry]')).toHaveCount(0);
    await expect(
      page.locator(`[data-testid=commit-row][data-hash="${stashOid.trim()}"]`),
    ).toHaveCount(0);

    const screenshot = resolve(import.meta.dirname, '..', '..', 'reports', 'stash.png');
    await mkdir(dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot });
    console.log(`screenshot: ${screenshot}`);
  } finally {
    await closeApp(handle);
    await rm(repo, { recursive: true, force: true });
  }
});
