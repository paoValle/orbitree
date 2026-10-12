import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { closeApp, commit, git, launchApp, mainWindow, makeRepo, writeIn } from './support.ts';

/** The actions the menu draws, in order, as the task freezes them. */
const MENU_ACTIONS = [
  'create-branch',
  'create-tag',
  'checkout',
  'reset-hard',
  'copy-sha',
  'copy-short-sha',
  'copy-message',
] as const;

test('a commit menu reached with the mouse and the keyboard, and the commands behind it', async () => {
  const repo = await makeRepo();
  await writeIn(repo, 'one.txt', 'one\n');
  await commit(repo, 'first commit');
  await writeIn(repo, 'two.txt', 'two\n');
  await commit(repo, 'second commit');
  await writeIn(repo, 'three.txt', 'three\n');
  await commit(repo, 'third commit');

  // The middle commit, named by git rather than by the row's own attribute.
  const target = await git(repo, ['rev-parse', 'HEAD~1']);
  const before = await git(repo, ['rev-list', '--count', '--all']);

  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    await expect(page.locator('[data-testid=commit-row]')).toHaveCount(3);
    const second = page.locator('[data-testid=commit-row]').nth(1);
    await expect(second).toHaveAttribute('data-hash', target);

    // Right-click opens the menu at the pointer, with exactly the seven actions.
    await second.click({ button: 'right' });
    const menu = page.locator('[data-testid=commit-menu]');
    await expect(menu).toBeVisible();
    const items = page.locator('[data-testid=menu-item]');
    await expect(items).toHaveCount(7);
    expect(
      await items.evaluateAll((elements) => elements.map((el) => el.getAttribute('data-action'))),
    ).toEqual([...MENU_ACTIONS]);

    // With the menu open, so the screenshot is of the feature and not of a closed one. Resolved
    // from this file, so the caller's working directory does not decide where it lands.
    const screenshot = resolve(import.meta.dirname, '..', '..', 'reports', 'menu.png');
    await mkdir(dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot });
    console.log(`screenshot: ${screenshot}`);

    // Escape closes it, and nothing in the repository moved.
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    expect(await git(repo, ['rev-list', '--count', '--all'])).toBe(before);

    // Shift+F10 on a focused row is the keyboard path, and the reason the menu is not
    // a mouse-only feature.
    await second.focus();
    await page.keyboard.press('Shift+F10');
    await expect(menu).toBeVisible();
    await expect(items).toHaveCount(7);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // Create branch here… asks for a name, then creates the branch at that commit.
    await second.click({ button: 'right' });
    await page.locator('[data-action=create-branch]').click();
    const ask = page.locator('[data-testid=ask-dialog]');
    await expect(ask).toBeVisible();
    await page.locator('[data-testid=ask-input]').fill('menu-made-branch');
    await page.locator('[data-testid=ask-confirm]').click();
    await expect
      .poll(() =>
        git(repo, ['show-ref', '--verify', '--hash', 'refs/heads/menu-made-branch']).catch(
          () => '',
        ),
      )
      .toBe(target);

    // Copy SHA writes the full hash to the machine's clipboard. Read through the main process
    // and polled, because the write is asynchronous.
    await second.click({ button: 'right' });
    await page.locator('[data-action=copy-sha]').click();
    await expect
      .poll(() => handle.app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(target);

    // Reset --hard is destructive, so it opens the existing confirmation sheet and runs nothing.
    const headBefore = await git(repo, ['rev-parse', 'HEAD']);
    await second.click({ button: 'right' });
    await page.locator('[data-action=reset-hard]').click();
    const sheet = page.locator('[role=dialog]');
    await expect(sheet).toBeVisible();
    await expect(page.locator('[placeholder=reason]')).toBeVisible();
    await expect(sheet.locator('button.danger')).toBeDisabled();
    expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(headBefore);
  } finally {
    await closeApp(handle);
    await rm(repo, { recursive: true, force: true });
  }
});
