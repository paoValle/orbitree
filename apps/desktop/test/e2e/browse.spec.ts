import { expect, test } from '@playwright/test';
import { closeApp, launchApp, mainWindow, makeRepo } from './support.ts';

/**
 * The dialog is native, so a click cannot be simulated. What can be proved is the thing that
 * was broken: that the button asks the main process for a directory at all. The stub answers
 * in its place, and everything after it is the real path — the channel, the tab, the read.
 */
test('Browse asks for a directory and opens what it is given', async () => {
  const repo = await makeRepo({ base: 'browse target\n' });
  const { app, userDataDir } = await launchApp();
  try {
    await app.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picked] });
    }, repo);

    const page = await mainWindow(app);
    const browse = page.getByRole('button', { name: 'Browse' });

    // An empty path is the state a picker exists for, so the button must be usable in it.
    await expect(page.getByPlaceholder('/path/to/a/repository')).toHaveValue('');
    await expect(browse).toBeEnabled();

    await browse.click();

    await expect(page.getByTestId('tabbar')).toBeVisible();
    await expect(page.getByTestId('tab')).toHaveCount(1);
    await expect(page.getByTestId('graph-count')).toContainText('1 of 1 commits');

    await page.screenshot({ path: 'reports/browse.png' });
  } finally {
    await closeApp({ app, userDataDir });
  }
});

test('a cancelled picker opens nothing and leaves the window as it was', async () => {
  const { app, userDataDir } = await launchApp();
  try {
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });

    const page = await mainWindow(app);
    await page.getByRole('button', { name: 'Browse' }).click();

    await expect(page.getByTestId('tabbar')).toHaveCount(0);
  } finally {
    await closeApp({ app, userDataDir });
  }
});
