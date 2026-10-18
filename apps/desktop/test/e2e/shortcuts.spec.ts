import { expect, test } from '@playwright/test';
import { closeApp, launchApp, mainWindow, makeRepo } from './support.ts';

/**
 * The tab shortcuts: switch by number, open, close.
 *
 * One modifier, `Cmd` on macOS and `Ctrl` elsewhere, which is why the tests name it from the platform
 * rather than picking one: a shortcut that only works on the machine it was written on is not a
 * shortcut. `9` is the last tab, the convention every browser trained a reader to expect.
 */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * The address, matched by the directory it ends in.
 *
 * On a Mac the fixture is made under `/var` and git answers `/private/var`, so the assertion is about
 * which repository a tab is showing rather than about how the machine spells it.
 */
const endsWith = (path: string): RegExp => new RegExp(`${path.split('/').pop()}$`);

test('the keyboard switches, opens and closes tabs', async () => {
  const first = await makeRepo({ base: 'the first repository\n' });
  const second = await makeRepo({ base: 'the second repository\n' });

  const handle = await launchApp(first);
  try {
    const page = await mainWindow(handle.app);
    const tabs = page.locator('[data-testid=tab]');
    const address = page.locator('input.path');
    /** The tab the window is showing, by position: the active class is what a reader sees. */
    const activeIndex = async (): Promise<number> => {
      const classes = await tabs.evaluateAll((elements) =>
        elements.map((element) => element.className),
      );
      return classes.findIndex((className) => className.includes('active'));
    };

    // One repository, opened by the launch argument.
    await expect(tabs).toHaveCount(1);
    await expect(address).toHaveValue(endsWith(first));

    // A tab with nothing in it, through the shortcut rather than the `+`: the same thing the button
    // does, and the header browses from there.
    await page.keyboard.press(`${MOD}+t`);
    await expect(tabs).toHaveCount(2);
    await expect(address).toHaveValue('');

    // Opening a repository opens a tab of its own rather than filling the one that is there, which is
    // the whole of "a tab per repository".
    await address.fill(second);
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(tabs).toHaveCount(3);
    await expect(address).toHaveValue(endsWith(second));

    // `1` and `3` are the tabs in order, and the address follows whichever is active.
    await page.keyboard.press(`${MOD}+1`);
    await expect(address).toHaveValue(endsWith(first));
    expect(await activeIndex()).toBe(0);
    await page.keyboard.press(`${MOD}+3`);
    await expect(address).toHaveValue(endsWith(second));
    expect(await activeIndex()).toBe(2);

    // `9` is the last one, whatever the count.
    await page.keyboard.press(`${MOD}+9`);
    expect(await activeIndex()).toBe(2);

    // A number with no tab behind it does nothing, rather than opening something.
    await page.keyboard.press(`${MOD}+7`);
    await expect(tabs).toHaveCount(3);
    expect(await activeIndex()).toBe(2);

    // `w` closes the active tab, and the one beside it becomes active: the last of what is left.
    await page.keyboard.press(`${MOD}+w`);
    await expect(tabs).toHaveCount(2);
    expect(await activeIndex()).toBe(1);

    // And a middle click closes the tab under the pointer, which is what the gesture means on a tab
    // strip.
    await tabs.nth(0).click({ button: 'middle' });
    await expect(tabs).toHaveCount(1);
  } finally {
    await closeApp(handle);
  }
});
