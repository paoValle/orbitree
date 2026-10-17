import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { closeApp, git, launchApp, mainWindow, makeRepo, makeRunDir } from './support.ts';

/**
 * The remotes, managed from the panel.
 *
 * Every assertion about what happened is `git`'s own answer rather than the card's, because the card
 * is the thing under test: a list that says a remote was renamed is a list that could be saying
 * anything. The fixture starts with none, so each step is a change the panel made.
 */
test('a remote is added, renamed, re-pointed and removed from the panel', async () => {
  const beside = await makeRunDir('remotes-');
  const repo = await makeRepo({ base: 'the first line\n' });
  const bare = join(beside, 'remote.git');
  await git(beside, ['init', '--bare', '-b', 'main', '--quiet', bare]);

  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    const section = page.locator('[data-testid=panel-section][data-section=Remotes]');
    await expect(section).toContainText('0');

    // Added: a name and where it points, which is the one dialog with two fields.
    await page.locator('[data-testid=remote-add]').click();
    await expect(page.locator('[data-testid=ask-dialog]')).toBeVisible();
    // The one dialog with two fields, and it will not run on half of them.
    await expect(page.locator('[data-testid=ask-confirm]')).toBeDisabled();
    await page.locator('[data-testid=ask-input]').fill('origin');
    await page.locator('[data-testid=ask-input-url]').fill(`file://${bare}`);
    await page.locator('[data-testid=ask-confirm]').click();

    const row = page.locator('[data-testid=remote-row][data-remote=origin]');
    await expect(row).toBeVisible();
    await expect(row).toContainText(`file://${bare}`);
    // git's own answer, and the argv the card recorded: `remote add origin file://…`.
    expect(await git(repo, ['remote', 'get-url', 'origin'])).toBe(`file://${bare}`);
    await expect(page.locator('[data-testid=activity-argv]').first()).toContainText(
      'git remote add origin file://',
    );

    // Renamed: the name moves and the URL stays where it was.
    await page.locator('[data-testid=remote-rename]').first().click();
    await page.locator('[data-testid=ask-input]').fill('upstream');
    await page.locator('[data-testid=ask-confirm]').click();
    await expect(page.locator('[data-testid=remote-row][data-remote=upstream]')).toBeVisible();
    expect(await git(repo, ['remote'])).toBe('upstream');

    // Re-pointed: the same name, another URL, read back with git.
    await page.locator('[data-testid=remote-url]').first().click();
    await page.locator('[data-testid=ask-input]').fill('../somewhere-else');
    await page.locator('[data-testid=ask-confirm]').click();
    await expect.poll(() => git(repo, ['remote', 'get-url', 'upstream'])).toBe('../somewhere-else');
    await expect(page.locator('[data-testid=remote-row]')).toContainText('../somewhere-else');

    // Removed: the name and its tracking refs go, and git agrees there are none left.
    await page.locator('[data-testid=remote-remove]').first().click();
    await expect(page.locator('[data-testid=remote-row]')).toHaveCount(0);
    expect(await git(repo, ['remote'])).toBe('');

    await page.screenshot({
      path: join(import.meta.dirname, '..', '..', 'reports', 'remotes.png'),
    });
  } finally {
    await closeApp(handle);
    await rm(beside, { recursive: true, force: true });
  }
});
