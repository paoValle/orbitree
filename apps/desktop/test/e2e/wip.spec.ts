import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { closeApp, commit, git, launchApp, mainWindow, makeRepo, writeIn } from './support.ts';

/**
 * The working tree at the top of the graph: the product's own argument about a detached head,
 * applied to what is not committed yet.
 *
 * The counts asserted here are the ones this test made with the real `git` binary — one file
 * staged, one modified in the working tree, one untracked — so they are not read back from the
 * thing under test.
 */
test('the working tree is a node above the first commit', async () => {
  const repo = await makeRepo({ base: 'base\n' });
  await writeIn(repo, 'base.txt', 'modified in the working tree\n');
  await writeIn(repo, 'staged.txt', 'added to the index\n');
  await git(repo, ['add', 'staged.txt']);
  await writeIn(repo, 'untracked.txt', 'never added\n');

  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    const wip = page.locator('[data-testid=wip-row]');
    await expect(wip).toBeVisible();
    await expect(wip).toContainText('WIP');
    await expect(wip).toContainText('1 staged · 1 changed · 1 untracked');

    // Above the first commit rather than beside it: the picture is read top to bottom.
    const firstCommit = page.locator('[data-testid=commit-row]').first();
    const wipBox = await wip.boundingBox();
    const firstBox = await firstCommit.boundingBox();
    if (wipBox === null || firstBox === null) throw new Error('the pane did not lay out');
    expect(wipBox.y + wipBox.height).toBeLessThanOrEqual(firstBox.y);

    // A fact beside the rows, not a row of its own: the commit below it is still the only
    // commit, still the one HEAD points at, and still what the header counts.
    const head = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    const rows = page.locator('[data-testid=commit-row]');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-hash', head);
    await expect(page.locator('[data-testid=graph-count]')).toContainText('1 of 1 commits');
    await rows.first().click();
    await expect(page.locator('[data-testid=commit-row-selected]')).toHaveAttribute(
      'data-hash',
      head,
    );

    const screenshot = resolve('reports/wip.png');
    await mkdir(dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot });
    console.log(`screenshot: ${screenshot}`);
  } finally {
    await closeApp(handle);
  }
});

/**
 * The other direction: a history filtered to a branch that does not hold HEAD is a picture of
 * that branch, and a node joined to nothing would misstate where the working tree sits.
 */
test('a history that does not hold HEAD draws no node', async () => {
  const repo = await makeRepo({ base: 'base\n' });
  await git(repo, ['checkout', '--quiet', '-b', 'other']);
  await writeIn(repo, 'other.txt', 'on the other branch\n');
  await commit(repo, 'a commit only on other');
  // Back on main with a commit of its own, so the two heads diverge: `other` is not an
  // ancestor of HEAD, and its history does not hold the commit the working tree sits on.
  await git(repo, ['checkout', '--quiet', 'main']);
  await writeIn(repo, 'main.txt', 'on main\n');
  await commit(repo, 'a commit only on main');
  // Dirty on purpose: if the node were drawn, it would have something to say.
  await writeIn(repo, 'base.txt', 'modified in the working tree\n');

  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    await expect(page.locator('[data-testid=wip-row]')).toBeVisible();

    await page.locator('[data-testid=ref-row][data-ref="other"] [data-testid=ref-read]').click();
    await expect(page.locator('[data-testid=graph-count]')).toContainText('2 of 2 commits');
    await expect(page.locator('[data-testid=wip-row]')).toHaveCount(0);

    // Back to every ref, where the commit HEAD sits on is in the window again.
    await page.locator('[data-testid=ref-all]').click();
    await expect(page.locator('[data-testid=wip-row]')).toBeVisible();
  } finally {
    await closeApp(handle);
  }
});
