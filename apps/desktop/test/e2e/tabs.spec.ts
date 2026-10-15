import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { closeApp, commit, launchApp, mainWindow, makeRepo, writeIn } from './support.ts';

/**
 * Two repositories open at once, each one its own reading.
 *
 * The tab is not a path: it carries the history that was read, the ref it is filtered to and
 * the commit selected in it. So the check that matters is that switching back to a tab shows
 * *its* repository and keeps *its* selection, rather than re-reading whatever is active now.
 */
test('two repositories at once, each with its own selection', async () => {
  const first = await makeRepo();
  const second = await makeRepo();
  await writeIn(first, 'a.txt', 'in the first repository\n');
  await commit(first, 'the first commit');
  await writeIn(second, 'b.txt', 'in the second repository\n');
  await writeIn(second, 'c.txt', 'and another\n');
  await commit(second, 'the only commit');

  const handle = await launchApp(first);
  try {
    const page = await mainWindow(handle.app);
    await expect(page.locator('[data-testid=graph-count]')).toBeVisible();

    // A second repository, in a new tab, from the path box.
    await page.locator('input.path').fill(second);
    await page.locator('input.path').press('Enter');
    const tabs = page.locator('[data-testid=tab]');
    await expect(tabs).toHaveCount(2);
    // The new tab is the active one, and it shows its own history: one commit, and the
    // subject that commit has.
    await expect(page.locator('[data-testid=tab].active')).toContainText(
      second.slice(second.lastIndexOf('/') + 1),
    );
    await expect(page.locator('[data-testid=graph-count]')).toHaveText(/1 of 1 commits/);

    // Selecting a commit in this tab, then switching away and back, keeps both: the same
    // repository and the same selection.
    await page.locator('[data-testid=commit-row]').first().click();
    const selectedInSecond = await page
      .locator('[data-testid=commit-row-selected]')
      .getAttribute('data-hash');
    await expect(page.locator('[data-testid=commit-subject]')).toContainText('the only commit');

    await tabs.first().click();
    // The first tab shows the first repository's history again, not the second's.
    await expect(page.locator('[data-testid=graph-count]')).toHaveText(/1 of 1 commits/);
    await expect(page.locator('[data-testid=commit-row]').first()).toContainText(
      'the first commit',
    );

    await tabs.last().click();
    // Coming back, the selection is still the commit chosen here, so the panel is already
    // showing it rather than the top of the list.
    await expect(page.locator('[data-testid=commit-row-selected]')).toHaveAttribute(
      'data-hash',
      selectedInSecond ?? '',
    );

    const screenshot = resolve(import.meta.dirname, '..', '..', 'reports', 'tabs.png');
    await mkdir(dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot });
    console.log(`screenshot: ${screenshot}`);

    // Closing the active tab leaves the first one, and the bar goes back to one tab.
    await page.locator('.tab-close').last().click();
    await expect(tabs).toHaveCount(1);
    await expect(page.locator('[data-testid=commit-row]').first()).toContainText(
      'the first commit',
    );
  } finally {
    await closeApp(handle);
  }
});
