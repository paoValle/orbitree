import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import {
  closeApp,
  commit,
  EFFECT_TIMEOUT,
  git,
  launchApp,
  mainWindow,
  makeRepo,
  writeIn,
} from './support.ts';

/**
 * Searching the history, applied to the picture.
 *
 * The fixture has commits by two authors and two subjects, so a search can be narrow in a way that is
 * visible: what is asserted is `git log`'s own answer for the same question, on the rows the graph
 * draws, and that the header says the picture is a search rather than the whole repository.
 */
const plain = promisify(execFile);

test('the graph is searched by message, author and date, and says so', async () => {
  const repo = await makeRepo({ base: 'the base\n' });
  await writeIn(repo, 'a.txt', 'a\n');
  await commit(repo, 'the parser reads the status');
  await writeIn(repo, 'b.txt', 'b\n');
  // A commit by somebody else, so `only mine` has something to exclude. The identity cannot come from
  // `-c user.name`, because the fixture helper sets it in the *environment*, which wins.
  await git(repo, ['add', '-A']);
  await plain('git', ['commit', '--quiet', '-m', 'a change from elsewhere'], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Somebody Else',
      GIT_AUTHOR_EMAIL: 'somebody@example.invalid',
      GIT_COMMITTER_NAME: 'Somebody Else',
      GIT_COMMITTER_EMAIL: 'somebody@example.invalid',
    },
  });
  const all = (await git(repo, ['log', '--format=%H'])).split('\n').filter((line) => line !== '');
  expect(all).toHaveLength(3);

  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    const rows = page.locator('[data-testid=commit-row]');
    await expect(rows).toHaveCount(3);

    // By message: one commit, and the header says the picture is a search.
    await page.locator('[data-testid=search-grep]').fill('parser');
    await page.locator('[data-testid=search-apply]').click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('the parser reads the status');
    await expect(page.locator('[data-testid=graph-search]')).toBeVisible();
    const byMessage = (await git(repo, ['log', '--format=%H', '--grep=parser']))
      .split('\n')
      .filter((line) => line !== '');
    expect(byMessage).toHaveLength(1);
    await expect(rows.first()).toHaveAttribute('data-hash', byMessage[0] ?? '');

    // By author: the fixture's own commits, which is git's answer for the same text.
    await page.locator('[data-testid=search-clear]').click();
    await expect(rows).toHaveCount(3);
    await expect(page.locator('[data-testid=graph-search]')).toHaveCount(0);
    await page.locator('[data-testid=search-author]').fill('Somebody');
    await page.locator('[data-testid=search-apply]').click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('a change from elsewhere');
    const byAuthor = (await git(repo, ['log', '--format=%H', '--author=Somebody']))
      .split('\n')
      .filter((line) => line !== '');
    await expect(rows.first()).toHaveAttribute('data-hash', byAuthor[0] ?? '');

    // `only mine` is the address in force, not a text field: the fixture is authored by
    // `E2E Author`, so it is the two commits that are not the other author's.
    await page.locator('[data-testid=search-clear]').click();
    await page.locator('[data-testid=search-mine]').check();
    await page.locator('[data-testid=search-apply]').click();
    await expect(rows).toHaveCount(2);
    const mine = (await git(repo, ['log', '--format=%H', '--author=E2E Author']))
      .split('\n')
      .filter((line) => line !== '');
    expect(mine).toHaveLength(2);

    // A date: nothing in 2030, and the header still says the picture is a search rather than a
    // repository with nothing in it.
    await page.locator('[data-testid=search-clear]').click();
    await page.locator('[data-testid=search-since]').fill('2030-01-01');
    await page.locator('[data-testid=search-apply]').click();
    await expect.poll(async () => rows.count(), EFFECT_TIMEOUT).toBe(0);

    await page.locator('[data-testid=search-clear]').click();
    await expect(rows).toHaveCount(3);

    await page.screenshot({
      path: join(import.meta.dirname, '..', '..', 'reports', 'search.png'),
    });
  } finally {
    await closeApp(handle);
  }
});
