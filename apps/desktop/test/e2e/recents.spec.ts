import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  closeApp,
  commit,
  launchApp,
  mainWindow,
  makeRepo,
  readStateFile,
  writeIn,
} from './support.ts';

/**
 * The recents and the last repository, proven by launching twice into the same user-data
 * directory: the app is the only thing that writes that file, so the second launch either
 * remembers or it does not, and there is no channel in between to flatter it.
 */
test('the last repository reopens, and the recents list what came before it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orbitree-state-'));
  const first = await makeRepo();
  const second = await makeRepo();
  await writeIn(first, 'a.txt', 'in the first repository\n');
  await commit(first, 'the first repository');
  await writeIn(second, 'b.txt', 'in the second repository\n');
  await commit(second, 'the second repository');

  const opened = await launchApp(first, { userDataDir: dir });
  try {
    const page = await mainWindow(opened.app);
    await expect(page.locator('[data-testid=graph-count]')).toBeVisible();
    await page.locator('input.path').fill(second);
    await page.locator('input.path').press('Enter');
    await page.waitForTimeout(700);
    console.log(
      '[debug] tabs:',
      await page.locator('[data-testid=tab]').count(),
      '| input:',
      await page.locator('input.path').inputValue(),
      '| state:',
      JSON.stringify((await page.evaluate(() => window.orbitree.readState())).value),
    );
    await expect(page.locator('[data-testid=graph-count]')).toContainText('1 commit');
    // Remembering finishes after the window has drawn, so the test waits for it rather than
    // reading the state the instant the graph appears.
    await expect
      .poll(async () => (await page.evaluate(() => window.orbitree.readState())).value?.last)
      .toBe(second);
  } finally {
    // Kept on purpose: the second launch has to find what the first one wrote.
    await closeApp(opened, { keep: true });
  }

  // The file, not the channel: what the second launch reads is what the first one wrote.
  const written = await readStateFile(dir);
  expect(written.last).toBe(second);
  expect(written.recents).toEqual([second, first]);

  // The second launch, no repository on the command line: the last one opens by itself,
  // and the header says whose history it is showing.
  const reopened = await launchApp(undefined, { userDataDir: dir });
  try {
    const page = await mainWindow(reopened.app);
    await expect(page.locator('[data-testid=graph-count]')).toHaveText(/1 of 1 commits/);
  } finally {
    await closeApp(reopened);
  }

  await rm(dir, { recursive: true, force: true });
});
