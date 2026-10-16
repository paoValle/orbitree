import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  closeApp,
  git,
  launchApp,
  mainWindow,
  makeRepo,
  makeRunDir,
  orbitree,
  writeIn,
} from './support.ts';

const MESSAGE = 'the same commit from both keys';

/**
 * The three fields the index and the message decide. The timestamp is deliberately not one
 * of them: it differs by construction, and asserting on it would make the test lie.
 */
interface CommitIdentity {
  readonly tree: string;
  readonly subject: string;
  readonly author: string;
}

async function identity(repo: string): Promise<CommitIdentity> {
  const [tree = '', subject = '', author = ''] = (
    await git(repo, ['log', '-1', '--format=%T%n%s%n%an <%ae>'])
  ).split('\n');
  return { tree, subject, author };
}

test('the app and the CLI produce the same commit object', async () => {
  const fixture = { base: 'base\n', staged: { path: 'change.txt', content: 'staged change\n' } };
  const appRepo = await makeRepo(fixture);
  const cliRepo = await makeRepo(fixture);
  try {
    // The CLI half: the same operation the app will run, through the product's own surface.
    const cli = await orbitree(
      ['run', cliRepo, '--op', 'commit', '--message', MESSAGE, '--json'],
      cliRepo,
    );
    expect(cli.exitCode).toBe(0);

    // The app half: type the message, click Commit, wait for the graph to show the commit.
    const handle = await launchApp(appRepo);
    try {
      const page = await mainWindow(handle.app);
      const messageBox = page.locator('[data-testid=commit-message]');
      await expect(messageBox).toBeVisible();
      // Something is staged but nothing is typed: the one reason the button is disabled here.
      await expect(page.locator('[data-testid=commit-disabled-reason]')).toHaveText(
        'a commit needs a message',
      );
      await messageBox.fill(MESSAGE);
      // Exactly, not as a substring: `toContainText` accepts a message with stray characters
      // appended, and one run produced `"…keyser"`, which is how this went unnoticed.
      await expect(messageBox).toHaveValue(MESSAGE);
      await expect(page.locator('[data-testid=commit-button]')).toBeEnabled();
      // Wait for the history to be drawn, so the screenshot shows the whole window.
      await expect(page.locator('[data-testid=commit-row]')).toHaveCount(1);

      // Taken with the message typed and the box enabled, so a person can look at it.
      const screenshot = resolve('reports/commit.png');
      await mkdir(dirname(screenshot), { recursive: true });
      await page.screenshot({ path: screenshot });
      console.log(`screenshot: ${screenshot}`);

      await page.locator('[data-testid=commit-button]').click();
      await expect(page.locator('[data-testid=commit-row]').first()).toContainText(MESSAGE);

      // The app made exactly one commit, and left nothing behind in the working tree.
      expect(await git(appRepo, ['rev-list', '--count', 'HEAD'])).toBe('2');
      expect(await git(appRepo, ['status', '--porcelain'])).toBe('');
      await expect(messageBox).toHaveValue('');
      await expect(page.locator('[data-testid=commit-amend]')).not.toBeChecked();
    } finally {
      await closeApp(handle);
    }

    const appIdentity = await identity(appRepo);
    const cliIdentity = await identity(cliRepo);
    console.log(
      `app: tree=${appIdentity.tree} subject=${JSON.stringify(appIdentity.subject)} author=${appIdentity.author}`,
    );
    console.log(
      `cli: tree=${cliIdentity.tree} subject=${JSON.stringify(cliIdentity.subject)} author=${cliIdentity.author}`,
    );
    expect(appIdentity.tree).toBe(cliIdentity.tree);
    expect(appIdentity.subject).toBe(cliIdentity.subject);
    expect(appIdentity.author).toBe(cliIdentity.author);
  } finally {
    await rm(appRepo, { recursive: true, force: true });
    await rm(cliRepo, { recursive: true, force: true });
  }
});

test('amend rewrites the message without adding a commit', async () => {
  const repo = await makeRepo({ base: 'the original message\n' });
  const before = await git(repo, ['rev-list', '--count', 'HEAD']);
  try {
    const handle = await launchApp(repo);
    try {
      const page = await mainWindow(handle.app);
      // Nothing is staged and nothing is typed: the reason names the missing stage first.
      await expect(page.locator('[data-testid=commit-disabled-reason]')).toHaveText(
        'nothing staged',
      );
      await page.locator('[data-testid=commit-message]').fill('the amended message');
      await expect(page.locator('[data-testid=commit-message]')).toHaveValue('the amended message');
      await expect(page.locator('[data-testid=commit-disabled-reason]')).toHaveText(
        'nothing staged',
      );
      // Amend is the one case where nothing staged is still a commit.
      await page.locator('[data-testid=commit-amend]').check();
      await expect(page.locator('[data-testid=commit-disabled-reason]')).toHaveCount(0);
      await expect(page.locator('[data-testid=commit-button]')).toBeEnabled();
      await page.locator('[data-testid=commit-button]').click();
      await expect(page.locator('[data-testid=commit-row]').first()).toContainText(
        'the amended message',
      );
    } finally {
      await closeApp(handle);
    }
    expect(await git(repo, ['rev-list', '--count', 'HEAD'])).toBe(before);
    expect(await git(repo, ['log', '-1', '--format=%s'])).toBe('the amended message');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

/**
 * A commit has two fields, and git is what puts the blank line between them.
 *
 * The box has a summary line and a description box; the command passes them as two `-m`, not as one
 * string this codebase joined. So the assertion is about what git made of them: `%B` is the summary,
 * a blank line, then the description.
 */
test('a summary and a description are two fields, and git joins them', async () => {
  const repo = await makeRepo({ base: 'the first line\n' });
  await writeIn(repo, 'base.txt', 'changed in the working tree\n');
  // The commit HEAD is on now is what an undo has to come back to, and the only place it can come
  // from: nothing in the repository afterwards says where HEAD was before.
  const before = await git(repo, ['rev-parse', 'HEAD']);

  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    await page
      .locator('li', { has: page.locator('[data-testid=entry-item][data-path="base.txt"]') })
      .getByRole('button', { name: 'stage' })
      .click();
    await page.locator('[data-testid=commit-message]').fill('say what changed');
    await page.locator('[data-testid=commit-body]').fill('and why, for whoever reads it later');
    await page.locator('[data-testid=commit-button]').click();

    await expect.poll(() => git(repo, ['log', '-1', '--format=%B'])).toContain('and why');
    const message = await git(repo, ['log', '-1', '--format=%B']);
    expect(message.split('\n\n')[0]).toBe('say what changed');
    expect(message.split('\n\n')[1]).toBe('and why, for whoever reads it later');
    // The window shows the summary in the graph, which is what the summary is for.
    await expect(page.locator('[data-testid=commit-row]').first()).toContainText(
      'say what changed',
    );

    // And the activity card names the command that puts the repository back, built from the state
    // before the commit: `--soft`, because the work is only in that commit.
    const reverse = page.locator('[data-testid=activity-reverse]').first();
    await expect(reverse).toContainText('git reset --soft');
    await expect(reverse).toContainText(before);

    const screenshot = resolve(import.meta.dirname, '..', '..', 'reports', 'undo.png');
    await mkdir(dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot });
    console.log(`screenshot: ${screenshot}`);
  } finally {
    await closeApp(handle);
    await rm(repo, { recursive: true, force: true });
  }
});

/**
 * Commit and push is two commands, in the order a person would run them.
 *
 * The remote is a bare repository beside the fixture, so the push is real and `git` is what says it
 * arrived; and the activity card has to show both commands, because that card is the product's
 * argument that every button is a `git` invocation somebody could type.
 */
test('commit and push commits, then pushes, and records both', async () => {
  const repo = await makeRepo({ base: 'the first line\n' });
  // `git` runs with a directory as its working directory, so the bare repository is created from
  // the directory beside it rather than from itself, which does not exist yet.
  const beside = await makeRunDir('remote-');
  const remote = join(beside, 'origin.git');
  await git(beside, ['init', '--bare', '--quiet', remote]);
  await git(repo, ['remote', 'add', 'origin', remote]);
  await writeIn(repo, 'base.txt', 'changed in the working tree\n');

  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    await page
      .locator('li', { has: page.locator('[data-testid=entry-item][data-path="base.txt"]') })
      .getByRole('button', { name: 'stage' })
      .click();
    await page.locator('[data-testid=commit-message]').fill('and push it somewhere');
    await page.locator('[data-testid=commit-and-push-button]').click();

    // The commit exists and the remote has it: two commands, and git is the one who says so.
    await expect.poll(() => git(repo, ['log', '-1', '--format=%s'])).toBe('and push it somewhere');
    const head = await git(repo, ['rev-parse', 'HEAD']);
    // Polled with a catch, because `git` on a ref that is not there yet *rejects*: without it the
    // first read fails the test instead of being retried, which is how this test failed first.
    await expect
      .poll(() => git(remote, ['rev-parse', 'refs/heads/main']).catch(() => ''))
      .toBe(head);

    const commands = page.locator('[data-testid=activity-argv]');
    await expect(commands.first()).toContainText('git push origin HEAD');
    await expect(commands.nth(1)).toContainText('git commit');
  } finally {
    await closeApp(handle);
    await rm(repo, { recursive: true, force: true });
  }
});
