import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  closeApp,
  commit,
  launchApp,
  mainWindow,
  makeRepo,
  readStateFrom,
  writeIn,
} from './support.ts';

/**
 * Closing the window hides the app, and the quick window is something the machine can
 * produce without a mouse.
 *
 * The global hotkey itself is not asserted: registering one needs a key the test cannot
 * press, and on a headless runner the registration is refused outright. What is asserted
 * is everything around it — the setting persists and is read back, the same action the
 * hotkey and the tray menu call opens the quick window, and closing the main window leaves
 * the process alive rather than quitting.
 */
test('closing the window hides it, and the quick window opens without a mouse', async () => {
  const repo = await makeRepo();
  await writeIn(repo, 'a.txt', 'in the repository\n');
  await commit(repo, 'the only commit');
  const name = repo.slice(repo.lastIndexOf('/') + 1);

  const handle = await launchApp(repo, { tray: true, quiet: false });
  try {
    const page = await mainWindow(handle.app);
    await expect(page.locator('[data-testid=graph-count]')).toBeVisible();

    // The hotkey is a setting: it persists, and the main process reads it back.
    await page.evaluate(() => window.orbitree.setHotkey('CommandOrControl+Alt+O'));
    await expect
      .poll(async () => (await readStateFrom(page)).hotkey)
      .toBe('CommandOrControl+Alt+O');

    // The quick window, through the same action the hotkey calls. It is a second window
    // with the compact layout: the repository's name and the commands, and no graph.
    await page.evaluate(() => window.orbitree.togglePopup());
    await expect
      .poll(async () => (await handle.app.windows()).length, { timeout: 4000 })
      .toBeGreaterThan(1);

    const popupPage = (await handle.app.windows()).find((candidate) => candidate !== page);
    expect(popupPage).toBeDefined();
    if (popupPage === undefined) return;
    // The compact window, and not a second copy of the app: its own layout, and no graph.
    await expect(popupPage.locator('.popup')).toHaveCount(1);
    await expect(popupPage.locator('[data-testid=graph-count]')).toHaveCount(0);
    // The repository it is about, by name. Read with `textContent`, which needs no
    // visibility: the quick window hides itself when it loses focus.
    await expect(popupPage.locator('.popup-head strong')).toHaveText(name, { timeout: 8000 });
    console.log('[tray] popup asserted');

    const screenshot = resolve(import.meta.dirname, '..', '..', 'reports', 'tray.png');
    await mkdir(dirname(screenshot), { recursive: true });
    await popupPage.screenshot({ path: screenshot });
    console.log(`screenshot: ${screenshot}`);

    // Closing the window is not quitting.
    //
    // Driven from the main process rather than with `page.close()`: the renderer's page is
    // not destroyed when the window hides — that is the point of the behaviour — so
    // Playwright's page teardown would wait for a page that never goes away.
    console.log('[tray] before app.evaluate visible');
    const visible = await handle.app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.webContents.getURL().includes('popup=1'),
      );
      return window?.isVisible() ?? null;
    });
    expect(visible).toBe(true);

    await handle.app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.webContents.getURL().includes('popup=1'),
      );
      window?.close();
    });

    // The main window, identified by its own URL: the quick window is on screen and would
    // answer for it.
    const mainVisible = (): Promise<boolean | null> =>
      handle.app.evaluate(async ({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find((candidate) =>
          candidate.webContents.getURL().includes('popup=1'),
        );
        const main = BrowserWindow.getAllWindows().find(
          (candidate) => !candidate.webContents.getURL().includes('popup=1'),
        );
        return main?.isVisible() ?? (window === undefined ? null : false);
      });

    await expect.poll(mainVisible, { timeout: 6000 }).toBe(false);

    // And the process is still alive: the app that owns a tray icon stays where it is.
    // `exitCode`/`signalCode` are the two ways a child process reports it is over.
    const child = handle.app.process();
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  } finally {
    await closeApp(handle);
  }
});
