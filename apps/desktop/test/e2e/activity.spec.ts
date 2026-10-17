import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { closeApp, git, launchApp, mainWindow, makeRepo, writeIn } from './support.ts';

/**
 * The activity list is where the product's thesis becomes useful. The window and the CLI run the
 * same program, so the command that ran is not a log line to be read: it is a `git` invocation a
 * person can copy into a terminal.
 */
test('the activity list keeps the command, and it can be copied', async () => {
  const repo = await makeRepo({ base: 'base\n' });
  await writeIn(repo, 'base.txt', 'changed in the working tree\n');
  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    // This spec is first in the run, so it pays the machine's cold start, and on a Linux runner
    // that has taken longer than the default five seconds: one run failed right here with the
    // pane not yet drawn, and the same commit passed on a rerun. The number is about the runner;
    // the assertion is still about what the pane says once it is there.
    await expect(page.locator('[data-testid=graph-count]')).toContainText('1 commit', {
      timeout: 20_000,
    });

    await page.getByRole('button', { name: 'Stash', exact: true }).click();

    const argv = page.locator('[data-testid=activity-argv]').first();
    await expect(argv).toHaveText('git stash push');
    await expect(page.locator('[data-testid=activity-argv]')).toHaveCount(1);

    await page.locator('[data-testid=activity-copy]').first().click();

    // Polled, because the write is asynchronous: a single read found whatever the machine's
    // clipboard held before the click, which in one run was the contents of somebody's profile
    // README. Read through the main process, so the assertion is about the real clipboard rather
    // than about what the renderer says it wrote.
    await expect
      .poll(() => handle.app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe('git stash push');

    await page.screenshot({
      path: resolve(import.meta.dirname, '..', '..', 'reports', 'activity.png'),
    });
  } finally {
    await closeApp(handle);
  }
});

/**
 * A network failure says what to do, not only what git printed.
 *
 * The remote is a port nothing listens on — 9 is the discard port — so the failure is real, instant
 * and needs no network: git's own "Failed to connect" is what arrives, and the sentence beside it is
 * the part a person can act on. Both are asserted, because replacing git's words with advice would
 * make the advice unverifiable.
 */
test('a push that cannot reach the remote explains what to do', async () => {
  const repo = await makeRepo({ base: 'base\n' });
  await git(repo, ['remote', 'add', 'origin', 'https://127.0.0.1:9/no/such.git']);

  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    await page.getByRole('button', { name: 'Push', exact: true }).click();

    // The failing command is in the activity card, which is where a command's outcome lives, and
    // git's own words are still there beside the advice rather than replaced by it.
    const argv = page.locator('[data-testid=activity-argv]').first();
    await expect(argv).toHaveText('git push --progress origin HEAD');
    await expect(page.locator('.run-detail').first()).toContainText('Failed to connect');
    await expect(page.locator('[data-testid=activity-advice]')).toContainText('Check the network');
    // The exit code is the truth about what happened, and it is not zero.
    await expect(page.locator('.rc.bad').first()).toHaveText('128');
    await page.screenshot({
      path: resolve(import.meta.dirname, '..', '..', 'reports', 'network-failure.png'),
    });
  } finally {
    await closeApp(handle);
  }
});
