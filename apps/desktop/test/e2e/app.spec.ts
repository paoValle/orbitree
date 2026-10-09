import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { closeApp, commit, git, launchApp, makeRepo, writeIn } from './support.ts';

/**
 * The contract between this test and the components is the `data-testid` set, and nothing
 * else. If a test-id is renamed the test fails to find it, which is the point: the strings
 * are frozen in the task, and a rename is a deliberate act with a failing test attached.
 */
test('the graph pane and the commit panel on the real window', async () => {
  const repo = await makeRepo();
  await writeIn(repo, 'base.txt', 'base\n');
  await commit(repo, 'root commit');
  // `side` and `main` both grow from the root, so the merge that follows has two real
  // parents. A branch taken from a later `main` head would only fast-forward.
  await git(repo, ['checkout', '--quiet', '-b', 'side']);
  await writeIn(repo, 'side.txt', 'side\n');
  await commit(repo, 'side work');
  await git(repo, ['checkout', '--quiet', 'main']);
  await writeIn(repo, 'main.txt', 'main\n');
  await commit(repo, 'main work');
  const mainHash = await git(repo, ['rev-parse', 'HEAD']);
  await git(repo, ['merge', '--no-edit', 'side']);

  const handle = await launchApp(repo);
  const app = handle.app;

  try {
    const page = await app.firstWindow();

    // Four commits, and the merge is what makes the second lane exist.
    await expect(page.locator('[data-testid=graph-count]')).toContainText('4 commits');
    await expect(page.locator('[data-testid=commit-row]')).toHaveCount(4);

    // The first row is the merge: one diff against its first parent, so exactly one file.
    const firstRow = page.locator('[data-testid=commit-row]').first();
    const firstHash = await firstRow.getAttribute('data-hash');
    await firstRow.click();
    await expect(page.locator('[data-testid=commit-subject]')).toContainText('Merge branch');
    await expect(page.locator('[data-testid=file-item]')).toHaveCount(1);
    await expect
      .poll(async () => page.locator('[data-testid=diff-hunk]').count())
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(async () => page.locator('[data-testid=diff-line-add]').count())
      .toBeGreaterThanOrEqual(1);

    // A non-merge commit whose diff is the file it added.
    await page.locator(`[data-testid=commit-row][data-hash="${mainHash}"]`).click();
    await expect(page.locator('[data-testid=file-item]')).toHaveCount(1);
    await expect(page.locator('[data-testid=file-item]')).toHaveAttribute('data-path', 'main.txt');

    // Keyboard navigation: the scroll container is focusable, arrows move one row, Home
    // returns to the first commit without duplicating rows.
    const before = await page
      .locator('[data-testid=commit-row-selected]')
      .getAttribute('data-hash');
    await page.locator('[data-testid=graph-scroll]').focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    const after = await page.locator('[data-testid=commit-row-selected]').getAttribute('data-hash');
    expect(after).not.toBe(before);
    await page.keyboard.press('Home');
    await expect(page.locator('[data-testid=commit-row-selected]')).toHaveAttribute(
      'data-hash',
      firstHash ?? '',
    );
    await expect(page.locator('[data-testid=commit-row]')).toHaveCount(4);

    // The screenshot is taken with the panel populated, so it shows the product, not an
    // empty state.
    await firstRow.click();
    await expect(page.locator('[data-testid=commit-panel]')).toBeVisible();
    await expect(page.locator('[data-testid=commit-subject]')).toContainText('Merge branch');
    await expect(page.locator('[data-testid=file-item]').first()).toBeVisible();
    await expect(page.locator('[data-testid=diff-hunk]').first()).toBeVisible();
    const screenshot = resolve('reports/app.png');
    await mkdir(dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot });
    console.log(`screenshot: ${screenshot}`);
  } finally {
    await closeApp(handle);
    await rm(repo, { recursive: true, force: true });
  }
});
