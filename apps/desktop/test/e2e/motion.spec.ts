import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { closeApp, launchApp, mainWindow, makeRepo, writeIn } from './support.ts';

/**
 * Rule two of `docs/DESIGN.md`, which is the only rule there that a machine can hold: reduced
 * motion removes every transition and every animation, not shortens them.
 *
 * The other half of the criterion is that turning it on changes nothing the suite asserts. A rule
 * that removed the *signal* rather than the movement would pass the first half and fail that one,
 * so this spec stages a file with motion off and asserts the change is still stated in words.
 */
test('reduced motion removes every transition, and the app still says what changed', async () => {
  const repo = await makeRepo({ base: 'the first line\n' });
  await writeIn(repo, 'base.txt', 'changed in the working tree\n');

  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    // The panes exist once the graph has been read: measuring before that would find nothing and
    // report a missing element rather than a missing transition.
    await expect(page.locator('[data-testid=graph-count]')).toBeVisible();

    // The card is a pane that enters, and a row carries its selection background. Read from the
    // computed style rather than from the stylesheet, because the question is what the browser
    // resolved and not what was written down.
    const motion = (): Promise<readonly (readonly [string, string, string])[]> =>
      page.evaluate(() =>
        ['.card', '.row'].map((selector) => {
          const element = document.querySelector(selector);
          if (element === null) throw new Error(`the window has no ${selector} to measure`);
          const style = getComputedStyle(element);
          return [selector, style.transitionDuration, style.animationName] as const;
        }),
      );

    // First the other direction: if nothing animated in the first place, the assertion below
    // would pass while testing nothing at all.
    const moving = await motion();
    expect(moving.map(([selector, duration]) => [selector, duration !== '0s'])).toEqual([
      ['.card', true],
      ['.row', true],
    ]);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await motion()).toEqual([
      ['.card', '0s', 'none'],
      ['.row', '0s', 'none'],
    ]);

    // And the change itself is still legible: a file moves from one section to the other, and
    // the node at the top of the graph counts it there rather than fading it in.
    await page.getByRole('button', { name: 'stage', exact: true }).first().click();
    await expect(page.locator('[data-testid=unstage-button]')).toHaveCount(1);
    await expect(page.locator('[data-testid=wip-row]')).toContainText('1 staged');

    // The picture with motion off, because "changes nothing a test asserts" is not the whole
    // claim: the window still has to look complete to a person reading it as a still image.
    const screenshot = resolve(import.meta.dirname, '..', '..', 'reports', 'motion.png');
    await mkdir(dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot });
    console.log(`screenshot: ${screenshot}`);

    await page.emulateMedia({ reducedMotion: null });
    expect(await motion()).toEqual(await moving);
  } finally {
    await closeApp(handle);
  }
});
