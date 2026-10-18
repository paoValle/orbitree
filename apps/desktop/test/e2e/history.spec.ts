import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { closeApp, commit, git, launchApp, mainWindow, makeRepo, writeIn } from './support.ts';

/**
 * One file's history, in the pane the file is already in.
 *
 * The fixture writes two files in three commits, so the two histories differ: `touched.txt` is
 * changed twice and `other.txt` once. Every assertion is `git`'s own answer — `log --format=%H -- <file>`
 * — because a list that names three commits is a list that could be naming the wrong three.
 */
test('a file’s history lists the commits that touched it, and a row jumps to one', async () => {
  const repo = await makeRepo({ base: 'the first line\n' });
  await writeIn(repo, 'touched.txt', 'one\n');
  await writeIn(repo, 'other.txt', 'elsewhere\n');
  await commit(repo, 'the first version of both');
  await writeIn(repo, 'touched.txt', 'one\ntwo\n');
  await commit(repo, 'a second version of one file');
  // Both files are then left modified, because the pane this test drives lives in the working tree's
  // list: a clean file has no row to click, which is the pane's current limit and not this test's
  // subject.
  await writeIn(repo, 'touched.txt', 'one\ntwo\nthree\n');
  await writeIn(repo, 'other.txt', 'elsewhere\nand more\n');

  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    await page.locator('[data-testid=entry-item][data-path="touched.txt"]').click();
    await page.locator('[data-testid=view-history]').click();

    // git's own answer for the same question, read a second way.
    const expected = (await git(repo, ['log', '--format=%H', '--', 'touched.txt']))
      .split('\n')
      .filter((line) => line !== '');
    expect(expected).toHaveLength(2);

    const rows = page.locator('[data-testid=history-row]');
    await expect(rows).toHaveCount(expected.length);
    await expect(rows.nth(0)).toHaveAttribute('data-hash', expected[0] ?? '');
    await expect(rows.nth(0)).toContainText('a second version of one file');
    await expect(rows.nth(1)).toContainText('the first version of both');
    // The file that did not change in the second commit is not in this list, which is the difference
    // between a file's history and the repository's.
    await expect(page.locator('[data-testid=history]')).not.toContainText('other.txt');

    // And the other file's history is the other list: one commit, not two.
    await page.locator('[data-testid=entry-item][data-path="other.txt"]').click();
    await page.locator('[data-testid=view-history]').click();
    await expect(page.locator('[data-testid=history-row]')).toHaveCount(1);

    // The jump, which is the same one the blame pane offers.
    await page.locator('[data-testid=entry-item][data-path="touched.txt"]').click();
    await page.locator('[data-testid=view-history]').click();
    await page
      .locator('[data-testid=history-row]')
      .first()
      .locator('[data-testid=history-jump]')
      .click();
    await expect(page.locator('[data-testid=commit-row-selected]')).toHaveAttribute(
      'data-hash',
      expected[0] ?? '',
    );

    await page.screenshot({
      path: join(import.meta.dirname, '..', '..', 'reports', 'history.png'),
    });
  } finally {
    await closeApp(handle);
  }
});
