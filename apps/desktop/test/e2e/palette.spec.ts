import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { closeApp, git, launchApp, mainWindow, makeRepo } from './support.ts';

/**
 * The command palette: every command in one list, run through the same guarded path a click takes.
 *
 * The claim the bullet makes is "built from one registry that the quick bar also reads", so the test
 * checks the two surfaces against each other: every command the bar has is in the palette. What it does
 * with a chosen command is git's own answer — and, for a destructive one, the confirmation sheet.
 */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

test('the palette lists the commands, filters them, and runs one through the guard', async () => {
  const repo = await makeRepo({ base: 'the first line\n' });
  const head = await git(repo, ['rev-parse', 'HEAD']);

  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    const palette = page.locator('[data-testid=palette]');
    const items = page.locator('[data-testid=palette-item]');
    // The graph is drawn before anything is asked of the palette: the screenshot at the end is a record
    // of the palette over a repository, and a picture of it over a loading pane would be a picture of
    // the wrong thing.
    await expect(page.locator('[data-testid=graph-count]')).toContainText('commit');

    // One registry, two surfaces: every command in the bar is an item in the palette. Read from the
    // palette first, then from the bar, so the comparison is between what the app says twice.
    await page.keyboard.press(`${MOD}+k`);
    await expect(palette).toBeVisible();
    const labels = (await items.allInnerTexts()).join('\n');
    const bar = await page.locator('.quickbar button.quick').allInnerTexts();
    expect(bar.length).toBeGreaterThan(5);
    for (const label of bar.map((text) => text.trim())) {
      if (label === 'Refresh') continue;
      expect(labels).toContain(label);
    }
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);

    // Typing filters by what a person would type: the label, the command, or where it lives.
    await page.keyboard.press(`${MOD}+k`);
    await page.locator('[data-testid=palette-input]').fill('stash');
    // Two, and that is the filter being honest: `Unstash` runs `stash pop`, so the command it would run
    // matches the word as well as the label. The first is the one whose *label* is the word.
    await expect(items).toHaveCount(2);
    await expect(items.first()).toHaveAttribute('data-command-id', 'stash');

    // A command that does not need a selection runs from the palette, and the activity card is where the
    // proof is: the same argv the bar would have run.
    await page.keyboard.press('Enter');
    await expect(palette).toHaveCount(0);
    await expect(page.locator('[data-testid=activity-argv]').first()).toHaveText('git stash push');

    // A destructive one stops at the sheet rather than running, whichever surface asked.
    await page.keyboard.press(`${MOD}+k`);
    await page.locator('[data-testid=palette-input]').fill('reset --hard');
    await expect(items).toHaveCount(1);
    await expect(items.first()).toHaveAttribute('data-danger', 'yes');
    await page.keyboard.press('Enter');
    const sheet = page.locator('[role=dialog]');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('reset --hard');
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    // Nothing ran: the card still names only the stash that was asked for, and the repository is where
    // it was. The sheet is what stops a destructive command, and this is the proof that it did.
    await expect(page.locator('[data-testid=activity-argv]')).toHaveCount(1);
    expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(head.trim());

    // A command about the selected commit is in the list only when a commit is selected, and running it
    // detaches the head — which git is asked about directly.
    await page.keyboard.press(`${MOD}+k`);
    await page.locator('[data-testid=palette-input]').fill('check out the selected');
    await expect(page.locator('[data-testid=palette-none]')).toBeVisible();
    await page.keyboard.press('Escape');

    const firstRow = page.locator('[data-testid=commit-row]').first();
    await firstRow.click();
    await page.keyboard.press(`${MOD}+k`);
    await page.locator('[data-testid=palette-input]').fill('check out the selected');
    await expect(items).toHaveCount(1);
    await page.screenshot({
      path: join(import.meta.dirname, '..', '..', 'reports', 'palette.png'),
    });
    await page.keyboard.press('Enter');
    await expect.poll(() => git(repo, ['rev-parse', 'HEAD'])).toBe(head.trim());
    // Detached: there is no branch to name.
    await expect
      .poll(() => git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''))
      .toBe('');
  } finally {
    await closeApp(handle);
  }
});
