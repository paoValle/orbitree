import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { closeApp, commit, git, launchApp, mainWindow, makeRepo, writeIn } from './support.ts';

/**
 * The four places a repository can be, each of which used to arrive as the same thing: an
 * error banner reading `git exited with 128`. Each test builds its own repository with the
 * real `git` binary through the shared helper, so the expectation comes from git and not from
 * a shape the app happens to produce.
 *
 * The contract is the `data-testid` set and nothing else: `state-screen` with a
 * `data-state`, plus the testids the panes already had.
 */
test('an unborn repository is a screen, and the working tree still works', async () => {
  const repo = await makeRepo();
  // A commit is never made, so HEAD points at a branch that does not exist. `git log` cannot
  // succeed here, which is exactly the state that used to produce the error banner.
  await writeIn(repo, 'hello.txt', 'first file, never committed\n');

  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);

    const screen = page.locator('[data-testid=state-screen]');
    await expect(screen).toHaveAttribute('data-state', 'unborn');
    await expect(screen).toContainText('No commits yet');

    // The working tree is the pane that still works, so it must be readable and populated.
    const workingTree = page.locator('[data-testid=working-tree]');
    await expect(workingTree).toBeVisible();
    await expect(workingTree).toContainText('hello.txt');
    await expect(page.locator('[data-testid=entry-item][data-path="hello.txt"]')).toBeVisible();

    // Nothing failed: the state is a place, not an error.
    await expect(page.locator('[role=alert]')).toHaveCount(0);
    // And there is no graph to draw, because `git log` cannot be asked.
    await expect(page.locator('[data-testid=graph-count]')).toHaveCount(0);
  } finally {
    await closeApp(handle);
    await rm(repo, { recursive: true, force: true });
  }
});

test('a detached head is a banner on a history that still reads', async () => {
  const repo = await makeRepo();
  await writeIn(repo, 'base.txt', 'base\n');
  await commit(repo, 'the only commit');
  await git(repo, ['checkout', '--quiet', '--detach']);

  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);

    const screen = page.locator('[data-testid=state-screen]');
    await expect(screen).toHaveAttribute('data-state', 'detached');
    await expect(screen).toContainText('Detached HEAD');

    // The history is still there: a detached head is not a reason to hide it.
    await expect(page.locator('[data-testid=graph-count]')).toContainText('1 commit');
    await expect(page.locator('[data-testid=commit-row]')).toHaveCount(1);
    await expect(page.locator('[role=alert]')).toHaveCount(0);
  } finally {
    await closeApp(handle);
    await rm(repo, { recursive: true, force: true });
  }
});

test('a conflicted merge is stated above the history, with the markers in the diff', async () => {
  const repo = await makeRepo();
  await writeIn(repo, 'shared.txt', 'base\n');
  await commit(repo, 'base');
  // Two branches changing the same line, so the merge has to stop and ask.
  await git(repo, ['checkout', '--quiet', '-b', 'left']);
  await writeIn(repo, 'shared.txt', 'left\n');
  await commit(repo, 'left');
  await git(repo, ['checkout', '--quiet', 'main']);
  await git(repo, ['checkout', '--quiet', '-b', 'right']);
  await writeIn(repo, 'shared.txt', 'right\n');
  await commit(repo, 'right');
  // The merge is *expected* to stop: a clean fast-forward would be the wrong fixture.
  const outcome = await git(repo, ['merge', '--no-edit', 'left']).then(
    () => 'merged cleanly',
    () => 'stopped on a conflict',
  );
  expect(outcome).toBe('stopped on a conflict');
  expect(await git(repo, ['rev-parse', '--verify', '-q', 'MERGE_HEAD'])).toMatch(/^[0-9a-f]{40}$/);

  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);

    const screen = page.locator('[data-testid=state-screen]');
    await expect(screen).toHaveAttribute('data-state', 'merge');
    await expect(screen).toContainText('Merge in progress');

    // The merge is a state above the graph, not instead of it: the history still reads.
    // Three commits, not four: the merge stopped before it could make one.
    await expect(page.locator('[data-testid=graph-count]')).toContainText('3 of 3 commits');

    // The conflicted file is listed in its own section, because that is where a reader
    // looks for what git stopped on.
    await expect(
      page.locator('[data-testid=wt-section][data-section=conflicted] [data-testid=entry-item]'),
    ).toHaveCount(1);
    await page
      .locator('[data-testid=wt-section][data-section=conflicted] [data-testid=entry-item]')
      .click();

    // "Conflict markers visible" in practice: the working tree against HEAD is a plain
    // diff whose added lines are the markers git wrote into the file.
    const wtDiff = page.locator('[data-testid=wt-diff]');
    await expect(wtDiff).toContainText('<<<<<<<');
    await expect(wtDiff).toContainText('=======');
    await expect(wtDiff).toContainText('>>>>>>>');
    await expect(wtDiff).toContainText('left');
    await expect(wtDiff).toContainText('right');

    // Both the state and the working tree on screen before the shutter.
    await expect(screen).toBeVisible();
    await expect(page.locator('[data-testid=working-tree]')).toBeVisible();
    const screenshot = resolve('reports/states.png');
    await mkdir(dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot });
    console.log(`screenshot: ${screenshot}`);

    await expect(page.locator('[role=alert]')).toHaveCount(0);
  } finally {
    await closeApp(handle);
    await rm(repo, { recursive: true, force: true });
  }
});
