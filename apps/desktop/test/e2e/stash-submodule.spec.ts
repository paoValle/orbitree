import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { closeApp, commit, git, launchApp, mainWindow, makeRepo, writeIn } from './support.ts';

/**
 * The stash and the submodule, both read only.
 *
 * `git stash push -m` prefixes its message, so the subject the UI shows is git's own words and
 * not a string this test typed. A submodule's third porcelain-v2 field (`S<c><m><u>`) is what
 * separates it from an ordinary file, and it is read from git in the test rather than assumed.
 */
test('the stash list and a submodule, read from the app', async () => {
  const repo = await makeRepo();
  const child = await makeRepo();

  await writeIn(child, 'child.txt', 'one\n');
  await commit(child, 'the child starts');
  await writeIn(repo, 'README.md', '# fixture\n');
  await commit(repo, 'the parent starts');
  // An absolute path: a relative one resolves against the process working directory rather than
  // against this repository. git requires the flag since CVE-2022-39253.
  await git(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'child']);
  await commit(repo, 'add the child as a submodule');

  // The child carries on — but in the *clone* `submodule add` left inside the parent, not in
  // the repository we cloned from: that is the working copy the parent actually checks out.
  // Its commit moving on is what makes git print `S.M..` rather than `S...`.
  await writeIn(resolve(repo, 'child'), 'child.txt', 'one\ntwo\n');
  await commit(resolve(repo, 'child'), 'the child carries on');

  await writeIn(repo, 'set-aside.txt', 'a sentinel\n');
  await git(repo, ['add', 'set-aside.txt']);
  await git(repo, ['stash', 'push', '--include-untracked', '-m', 'work that was set aside']);

  // What git itself prints, so the expectations are git's and not ours.
  const selectors = (await git(repo, ['stash', 'list', '--format=%gd'])).split('\n');
  const subject = (await git(repo, ['log', '-1', '--format=%s', selectors[0] as string])).trim();
  const submoduleState = (await git(repo, ['status', '--porcelain=v2']))
    .split('\n')
    .find((line) => line.split(' ')[2]?.startsWith('S'))
    ?.split(' ')[2];

  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    await expect(page.locator('[data-testid=working-tree]')).toBeVisible();

    // The stash card: one entry, the selector git prints, and git's subject rather than ours.
    await expect(page.locator('[data-testid=stash-list]')).toBeVisible();
    const entries = page.locator('[data-testid=stash-entry]');
    await expect(entries).toHaveCount(selectors.length);
    await expect(entries.first()).toHaveAttribute('data-selector', 'stash@{0}');
    await expect(entries.first()).toContainText(subject);
    await expect(entries.first()).toContainText('work that was set aside');

    // The submodule: the state git printed, and an entry that is not a plain file.
    const submoduleEntry = page.locator('[data-testid=entry-item][data-path="child"]');
    await expect(submoduleEntry).toBeVisible();
    await expect(submoduleEntry).toHaveAttribute('data-submodule', submoduleState ?? '');
    await expect(submoduleEntry.locator('[data-testid=entry-submodule]')).toBeVisible();

    const screenshot = resolve('reports/stash-submodule.png');
    await mkdir(dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot });
  } finally {
    await closeApp(handle);
    await rm(child, { recursive: true, force: true });
  }
});

test('a repository with no stash says so instead of showing an empty card', async () => {
  const repo = await makeRepo();
  await writeIn(repo, 'README.md', '# fixture\n');
  await commit(repo, 'the only commit');

  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    await expect(page.locator('[data-testid=working-tree]')).toBeVisible();
    await expect(page.locator('[data-testid=stash-entry]')).toHaveCount(0);
    await expect(page.locator('text=no stash in this repository')).toBeVisible();
  } finally {
    await closeApp(handle);
    await rm(repo, { recursive: true, force: true });
  }
});

/**
 * A stash is a place in the graph and not only a card in the side pane.
 *
 * The older entry is the one that matters: `--all` reaches `refs/stash`, which is the newest, and
 * an older stash is reachable from nothing but the reflog of that single ref. So a graph that only
 * followed refs would draw one of these two and call it a commit.
 */
test('both stashes are nodes in the graph, marked as stashes', async () => {
  const repo = await makeRepo({ base: 'one\n' });
  await writeIn(repo, 'base.txt', 'set aside first\n');
  await git(repo, ['stash', 'push', '--quiet', '-m', 'the first thing set aside']);
  await writeIn(repo, 'base.txt', 'set aside second\n');
  await git(repo, ['stash', 'push', '--quiet', '-m', 'the second thing set aside']);

  const stashOids = (await git(repo, ['stash', 'list', '--format=%H']))
    .split('\n')
    .filter((line) => line !== '');
  expect(stashOids).toHaveLength(2);

  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);

    // Both are rows, and each row says which stash it is — the first one by its selector, which is
    // the name a person would hand back to git.
    for (const oid of stashOids) {
      const row = page.locator(`[data-testid=commit-row][data-hash="${oid}"]`);
      await expect(row).toBeVisible();
      await expect(row.locator('.badge.stash')).toBeVisible();
    }
    await expect(page.locator('.badge.stash')).toHaveCount(stashOids.length);
    await expect(
      page.locator(`[data-testid=commit-row][data-hash="${stashOids[0] as string}"]`),
    ).toContainText('stash@{0}');

    const screenshot = resolve(import.meta.dirname, '..', '..', 'reports', 'stashes.png');
    await mkdir(dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot });
    console.log(`screenshot: ${screenshot}`);
  } finally {
    await closeApp(handle);
    await rm(repo, { recursive: true, force: true });
  }
});
