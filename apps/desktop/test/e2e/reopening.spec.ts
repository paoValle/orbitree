import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  closeApp,
  launchApp,
  mainWindow,
  makeRepo,
  makeRunDir,
  readStateFile,
  readStateFrom,
} from './support.ts';

/**
 * A repository whose directory has gone is a place, like an unborn head or a stopped merge: the
 * app can say what is true and what to do next. What it used to say was `not a directory: /path`,
 * a banner about the process rather than about the repository, on every launch, for ever.
 */
test('a repository that has gone is a state, and the app stops reopening it', async () => {
  const userDataDir = await makeRunDir('state-');
  const repo = await makeRepo({ base: 'base\n' });

  const opened = await launchApp(repo, { userDataDir });
  try {
    const page = await mainWindow(opened.app);
    await expect(page.locator('[data-testid=graph-count]')).toContainText('1 commit');
    // Remembering finishes after the window has drawn. Asserting on the file without waiting is
    // how a spec fails for its own race and gets blamed on the app.
    await expect.poll(async () => (await readStateFrom(page)).recents).toContain(repo);
  } finally {
    // Kept: the second launch has to find what the first one wrote.
    await closeApp(opened, { keep: true });
  }

  // The directory goes away between two launches, which is what happens when a repository is
  // moved, or a volume is not mounted.
  await rm(repo, { recursive: true, force: true });

  const reopened = await launchApp(undefined, { userDataDir });
  try {
    const page = await mainWindow(reopened.app);
    const screen = page.locator('[data-testid=state-screen]');
    await expect(screen).toContainText('Repository not found');
    await expect(screen).toContainText(repo);
    // The state is the message: no banner shouting about a process status.
    await expect(page.locator('.error')).toHaveCount(0);
    await expect(page.locator('[data-testid=graph-count]')).toHaveCount(0);
    // One sentence about the repository, not two that contradict each other.
    await expect(page.locator('.empty')).toHaveCount(0);
    // Nothing staged, no stash and no activity: four cards about a repository there is none of.
    await expect(page.locator('aside.side')).toHaveCount(0);
    // And the pane that is left takes the window rather than leaving a column of nothing.
    await expect(page.locator('main.panes.single')).toHaveCount(1);

    await page.screenshot({
      path: resolve(import.meta.dirname, '..', '..', 'reports', 'gone.png'),
    });
  } finally {
    await closeApp(reopened, { keep: true });
  }

  // What the app wrote, not what it says it wrote: it will not reopen the path, and the path
  // stays in the recents list, because a directory that is not mounted yet has not gone for good.
  const written = await readStateFile(userDataDir);
  expect(written.last).toBe(null);
  expect(written.recents).toContain(repo);
});
