import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  closeApp,
  EFFECT_TIMEOUT,
  git,
  launchApp,
  mainWindow,
  makeRepo,
  writeIn,
} from './support.ts';

/**
 * The two actions that leave the window: open a file with the machine's own application, and show it in
 * the file manager.
 *
 * Neither can be asserted by looking at the window — they are the *operating system's* windows — so the
 * main process's `shell` is replaced with a recorder for the length of the test. That is the honest way
 * to check a contract: what the test asserts is exactly what the product asked the operating system to
 * do, and the path it asked about, rather than the fact that no error came back.
 */
test('a file is opened with the machine’s application, and revealed in its file manager', async () => {
  const repo = await makeRepo({ base: 'the base\n' });
  await writeIn(repo, 'changed.txt', 'a change\n');
  // The path as *git* spells it: on a Mac the fixture is made under `/var` and git answers
  // `/private/var`, and the window resolves the file against the root git reported.
  const root = await git(repo, ['rev-parse', '--show-toplevel']);
  const file = resolve(root, 'changed.txt');

  const handle = await launchApp(repo);
  try {
    // The recorder, installed in the main process where `shell` lives. It keeps what it was asked for
    // and answers the way the real one would.
    await handle.app.evaluate(({ shell }) => {
      const asked: { openPath: string[]; revealed: string[] } = { openPath: [], revealed: [] };
      (globalThis as unknown as { __shellAsked: typeof asked }).__shellAsked = asked;
      shell.openPath = async (path: string): Promise<string> => {
        asked.openPath.push(path);
        return '';
      };
      shell.showItemInFolder = (path: string): void => {
        asked.revealed.push(path);
      };
    });

    const page = await mainWindow(handle.app);
    const row = page.locator('li', {
      has: page.locator('[data-testid=entry-item][data-path="changed.txt"]'),
    });
    await expect(row.locator('[data-testid=open-file]')).toBeVisible();

    await row.locator('[data-testid=open-file]').click();
    await expect
      .poll(async () =>
        handle.app.evaluate(
          () =>
            (globalThis as unknown as { __shellAsked: { openPath: string[] } }).__shellAsked
              .openPath,
        ),
      )
      .toEqual([file]);

    await row.locator('[data-testid=reveal-file]').click();
    await expect
      .poll(async () =>
        handle.app.evaluate(
          () =>
            (globalThis as unknown as { __shellAsked: { revealed: string[] } }).__shellAsked
              .revealed,
        ),
      )
      .toEqual([file]);

    // And a file the machine cannot open says so in the banner rather than doing nothing: the recorder is
    // told to fail this time, which is what a deleted file looks like.
    await handle.app.evaluate(({ shell }) => {
      shell.openPath = async (): Promise<string> => 'no such file';
    });
    await row.locator('[data-testid=open-file]').click();
    await expect(page.locator('[role=alert]')).toContainText('no such file', {
      timeout: EFFECT_TIMEOUT.timeout,
    });

    await expect(row.locator('[data-testid=reveal-file]')).toBeVisible();
    await page.screenshot({
      path: join(import.meta.dirname, '..', '..', 'reports', 'open-file.png'),
    });
  } finally {
    await closeApp(handle);
  }
});
