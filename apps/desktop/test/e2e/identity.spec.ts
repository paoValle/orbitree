import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { closeApp, git, launchApp, mainWindow, makeRepo } from './support.ts';

/**
 * Who commits will be authored as, in the window rather than in a terminal.
 *
 * The fixture configures its own name and email, and the test asks `git` where each value came from
 * rather than trusting the card: the card's claim is that it shows the file that won, and only git
 * knows which file that is.
 */
test('the identity in force is shown with the file it came from', async () => {
  const repo = await makeRepo({ base: 'the first line\n' });
  await git(repo, ['config', 'user.name', 'Panel Person']);

  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    const row = (part: string) => page.locator(`[data-testid=identity-row][data-part="${part}"]`);

    await expect(row('name')).toContainText('Panel Person');
    // The scope is what makes this worth showing: the same repository can inherit a name from a
    // global file and overrule it locally, and this says which one is in force.
    await expect(row('name')).toContainText('from local');
    await expect(row('email')).toContainText('e2e@example.invalid');
    // A part nobody set says so, because git refuses a commit without one and a reader needs to know
    // before they try rather than after.
    await expect(row('signing key')).toContainText('unset');

    // git's own answer for the same question, read a second way.
    expect(await git(repo, ['config', 'user.name'])).toBe('Panel Person');
    const origin = await git(repo, ['config', '--show-origin', 'user.email']);
    expect(origin).toContain('file:.git/config');
    expect(origin).toContain('e2e@example.invalid');

    await page.screenshot({
      path: join(import.meta.dirname, '..', '..', 'reports', 'identity.png'),
    });
  } finally {
    await closeApp(handle);
  }
});
