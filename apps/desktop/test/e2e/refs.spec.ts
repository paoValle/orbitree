import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { closeApp, commit, git, launchApp, mainWindow, makeRepo, writeIn } from './support.ts';

/**
 * The branches and the tags, which are names for commits and the only things in the product that
 * can be renamed and deleted.
 *
 * Every assertion about what happened is `git`'s own answer rather than the pane's, because the
 * pane is the thing under test: a list that says a branch was renamed is a list that could be
 * saying anything.
 */
test('a branch is switched to, renamed and deleted, and a tag is deleted', async () => {
  const repo = await makeRepo({ base: 'the first line\n' });
  await git(repo, ['branch', 'feature']);
  await git(repo, ['tag', 'v0.1']);

  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    const row = (name: string) => page.locator(`[data-testid=ref-row][data-ref="${name}"]`);
    await expect(page.locator('[data-testid=ref-row]')).toHaveCount(3);
    await expect(row('main')).toContainText('current');
    // The current branch is the one place a switch would go, so it is not offered.
    await expect(row('main').locator('[data-testid=ref-switch]')).toBeDisabled();

    // Switching is `git switch`, and afterwards git says which branch is checked out.
    await row('feature').locator('[data-testid=ref-switch]').click();
    await expect.poll(() => git(repo, ['symbolic-ref', '--short', 'HEAD'])).toBe('feature');
    await expect(row('feature')).toContainText('current');

    // Renaming asks for the new name first, and only then runs anything.
    await row('feature').locator('[data-testid=ref-rename]').click();
    const dialog = page.locator('[data-testid=ask-dialog]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Rename feature');
    await expect(dialog.locator('[data-testid=ask-confirm]')).toBeEnabled();
    await page.locator('[data-testid=ask-input]').fill('feature-renamed');
    await dialog.locator('[data-testid=ask-confirm]').click();
    await expect.poll(() => git(repo, ['symbolic-ref', '--short', 'HEAD'])).toBe('feature-renamed');
    await expect(row('feature')).toHaveCount(0);

    // Deleting a tag is destructive: it opens the sheet and refuses to run without a reason.
    await row('v0.1').locator('[data-testid=ref-delete]').click();
    const sheet = page.locator('[role=dialog]');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('button.danger')).toBeDisabled();
    expect(await git(repo, ['tag', '--list'])).toContain('v0.1');
    await page.locator('[placeholder=reason]').fill('the tag was a mistake');
    await sheet.locator('button.danger').click();
    await expect.poll(() => git(repo, ['tag', '--list'])).not.toContain('v0.1');

    const screenshot = resolve(import.meta.dirname, '..', '..', 'reports', 'refs.png');
    await mkdir(dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot });
    console.log(`screenshot: ${screenshot}`);
  } finally {
    await closeApp(handle);
    await rm(repo, { recursive: true, force: true });
  }
});

/** A branch with commits of its own is the one git refuses to delete without being told twice. */
test('the panel filters the names it holds without reading anything', async () => {
  const repo = await makeRepo({ base: 'the first line\n' });
  await git(repo, ['branch', 'feature-one']);
  await git(repo, ['branch', 'other-thing']);
  await git(repo, ['tag', 'v0.1']);

  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    const rows = page.locator('[data-testid=ref-row]');
    await expect(rows).toHaveCount(4);

    // Filtering is a question about what is shown, so it is not a git call and the graph does not
    // move: the count of commits read stays exactly where it was while the names come and go.
    const before = await page.locator('[data-testid=graph-count]').innerText();
    await page.locator('[data-testid=panel-search]').fill('feature');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-ref', 'feature-one');
    expect(await page.locator('[data-testid=graph-count]').innerText()).toBe(before);

    // A tag and a submodule are filtered by the same box, because the question asked of each row is
    // the same one.
    await page.locator('[data-testid=panel-search]').fill('v0');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-ref', 'v0.1');

    await page.locator('[data-testid=panel-search]').fill('nothing matches this');
    await expect(rows).toHaveCount(0);

    await page.locator('[data-testid=panel-search]').fill('');
    await expect(rows).toHaveCount(4);
  } finally {
    await closeApp(handle);
    await rm(repo, { recursive: true, force: true });
  }
});

test('hiding a name changes the picture and nothing else', async () => {
  const repo = await makeRepo({ base: 'the first line\n' });
  // A branch with a commit of its own, and a shared history: hiding the branch must drop that
  // commit and keep everything the two names have in common.
  await git(repo, ['checkout', '--quiet', '-b', 'lonely']);
  await writeIn(repo, 'lonely.txt', 'only on this branch\n');
  await commit(repo, 'a commit only lonely has');
  await git(repo, ['checkout', '--quiet', 'main']);
  const lonely = await git(repo, ['rev-parse', 'lonely']);
  const shared = await git(repo, ['rev-parse', 'HEAD']);
  expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(shared);

  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    const rows = page.locator('[data-testid=commit-row]');
    await expect(rows).toHaveCount(2);
    await expect(page.locator('[data-testid=graph-hidden]')).toHaveCount(0);

    await page.locator('[data-testid=ref-row][data-ref="lonely"] [data-testid=ref-hide]').click();

    // The commit only that branch could reach is not drawn, the shared one still is, and the header
    // says the picture is missing something — a count that disagreed with the rows would be worse
    // than no count.
    await expect(page.locator('[data-testid=graph-hidden]')).toContainText('hiding 1');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-hash', shared);
    await expect(page.locator(`[data-testid=commit-row][data-hash="${lonely}"]`)).toHaveCount(0);
    // The row says it is hidden and offers the way back, because a name that vanished from the list
    // would be a name nobody could bring back.
    await expect(
      page.locator('[data-testid=ref-row][data-ref="lonely"] [data-testid=ref-hidden]'),
    ).toBeVisible();

    // Nothing was written: the branch is where it was.
    expect(await git(repo, ['rev-parse', 'lonely'])).toBe(lonely);

    await page.locator('[data-testid=ref-row][data-ref="lonely"] [data-testid=ref-hide]').click();
    await expect(rows).toHaveCount(2);
    await expect(page.locator('[data-testid=graph-hidden]')).toHaveCount(0);

    const screenshot = resolve(import.meta.dirname, '..', '..', 'reports', 'hide.png');
    await mkdir(dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot });
    console.log(`screenshot: ${screenshot}`);
  } finally {
    await closeApp(handle);
    await rm(repo, { recursive: true, force: true });
  }
});

test('a branch is merged into the one that is checked out', async () => {
  const repo = await makeRepo({ base: 'the first line\n' });
  await git(repo, ['checkout', '--quiet', '-b', 'work']);
  await writeIn(repo, 'work.txt', 'done on the branch\n');
  await commit(repo, 'work on the branch');
  await git(repo, ['checkout', '--quiet', 'main']);
  // main moves on as well, so the merge is a real merge commit and not a fast-forward: a
  // fast-forward moves a branch and proves very little about the merge path.
  await writeIn(repo, 'main.txt', 'and on main\n');
  await commit(repo, 'work on main');
  expect(await git(repo, ['rev-list', '--count', 'HEAD'])).toBe('2');

  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    // Merging is offered for every branch but the one that is checked out: a merge is always into
    // the current branch, so the current branch cannot be merged into itself.
    await expect(
      page.locator('[data-testid=ref-row][data-ref="main"] [data-testid=ref-merge]'),
    ).toHaveCount(0);
    await page.locator('[data-testid=ref-row][data-ref="work"] [data-testid=ref-merge]').click();

    // Three commits then, and four with the merge commit on top: the merge is a real one, and git
    // is the one who says so.
    await expect.poll(() => git(repo, ['rev-list', '--count', 'HEAD'])).toBe('4');
    await expect(page.locator('[data-testid=activity-argv]').first()).toContainText(
      'merge --no-edit work',
    );
  } finally {
    await closeApp(handle);
    await rm(repo, { recursive: true, force: true });
  }
});

test('an unmerged branch is refused by git rather than deleted quietly', async () => {
  const repo = await makeRepo({ base: 'the first line\n' });
  await git(repo, ['checkout', '--quiet', '-b', 'unmerged']);
  await writeIn(repo, 'only-here.txt', 'a commit that is only on this branch\n');
  await commit(repo, 'a commit only on unmerged');
  await git(repo, ['checkout', '--quiet', 'main']);
  const tip = await git(repo, ['rev-parse', 'unmerged']);

  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    await page
      .locator('[data-testid=ref-row][data-ref="unmerged"] [data-testid=ref-delete]')
      .click();

    // The branch is still there, and the activity card shows the command that failed: a refusal
    // that leaves no evidence is a refusal nobody can explain.
    await expect(page.locator('[data-testid=activity-argv]').first()).toContainText(
      'branch -d unmerged',
    );
    expect(await git(repo, ['rev-parse', 'unmerged'])).toBe(tip);
  } finally {
    await closeApp(handle);
    await rm(repo, { recursive: true, force: true });
  }
});
