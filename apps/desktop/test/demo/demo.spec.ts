import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { closeApp, commit, git, launchApp, mainWindow, makeRepo, writeIn } from '../e2e/support.ts';

/**
 * The frames the README's GIFs are made of.
 *
 * Not a test: it asserts very little, on purpose, and it is not in the suite's `testDir` so
 * `make e2e` cannot run it. What it does is drive the real window through a sequence a person
 * would recognise and write one PNG per step; `bin/make-gifs.sh` turns each sequence into a GIF.
 *
 * The frames are numbered rather than named, because ffmpeg's `%02d` input is the one form every
 * build understands — `-pattern_type glob` is not compiled in everywhere. The step a frame shows
 * is printed, so a run says what it drew.
 */
async function frameWriter(
  sequence: string,
): Promise<(page: Page, label: string) => Promise<void>> {
  const dir = resolve('reports', 'demo', sequence);
  await mkdir(dir, { recursive: true });
  let index = 0;
  return async (page, label) => {
    index += 1;
    // A beat for the panes' 160 ms entry transitions. A screenshot taken during one is a blur
    // that says nothing about the layout, which is the whole reason the frame exists.
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(dir, `${String(index).padStart(2, '0')}.png`) });
    console.log(`[demo] ${sequence} ${String(index).padStart(2, '0')} ${label}`);
  };
}

/**
 * A repository with something worth looking at: a feature branch merged into `main`, so the graph
 * has lanes and a merge, and a working tree with all three kinds of waiting — one file staged, one
 * modified, one untracked — so the node above the first commit has something to say.
 */
async function makeGraphRepo(): Promise<string> {
  const repo = await makeRepo({ base: 'the first line\n' });
  await git(repo, ['checkout', '--quiet', '-b', 'feature/parser']);
  await writeIn(repo, 'parser.ts', 'export const parse = (line: string): string => line.trim();\n');
  await commit(repo, 'a parser, and the first test for it');
  await git(repo, ['checkout', '--quiet', 'main']);
  await writeIn(repo, 'README.md', '# demo\n\nWhat this repository is for.\n');
  await commit(repo, 'document what the parser is for');
  await git(repo, ['merge', '--no-edit', 'feature/parser']);
  await writeIn(
    repo,
    'parser.ts',
    'export const parse = (line: string): string => line.trimEnd();\n',
  );
  await writeIn(repo, 'CHANGELOG.md', '## Unreleased\n');
  await git(repo, ['add', 'CHANGELOG.md']);
  await writeIn(repo, 'notes.txt', 'not added to anything yet\n');
  return repo;
}

/** Three commits and nothing else, for the commit menu. */
async function makeMenuRepo(): Promise<string> {
  const repo = await makeRepo();
  await writeIn(repo, 'one.txt', 'one\n');
  await commit(repo, 'the first commit');
  await writeIn(repo, 'two.txt', 'two\n');
  await commit(repo, 'the second commit');
  await writeIn(repo, 'three.txt', 'three\n');
  await commit(repo, 'the third commit');
  return repo;
}

test('the graph, the working tree, and one commit', async () => {
  const repo = await makeGraphRepo();
  const shot = await frameWriter('graph');
  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    await expect(page.locator('[data-testid=wip-row]')).toBeVisible();
    await expect(page.locator('[data-testid=graph-count]')).toContainText('4 of 4 commits');
    await shot(page, 'the graph, lanes, and the working tree at the top');

    // The merge commit: its subject, its author, and the patch it brought in. The first file of
    // the patch is already the one on screen, so there is nothing to click to see it.
    await page.locator('[data-testid=commit-row]').first().click();
    await expect(page.locator('[data-testid=commit-subject]')).toBeVisible();
    await expect(page.locator('[data-testid=diff-hunk]').first()).toBeVisible();
    await shot(page, 'the merge commit, and the patch it brought in');

    // The working tree's own diff, which is a different comparison: the disk against the index
    // rather than a commit against its parent.
    await page.locator('[data-testid=entry-item]').filter({ hasText: 'parser.ts' }).first().click();
    await expect(page.locator('[data-testid=wt-diff]')).toBeVisible();
    await shot(page, 'an uncommitted change, with its diff');

    // And the same graph, read from one ref instead of from every ref.
    await page.selectOption('[data-testid=ref-filter]', { label: 'feature/parser' });
    await expect(page.locator('[data-testid=graph-count]')).toContainText('2 of 2 commits');
    await shot(page, 'the history read from one branch');
  } finally {
    await closeApp(handle);
  }
});

test('staging a change and committing it', async () => {
  const repo = await makeRepo({ base: 'the first line\n' });
  // `makeRepo` writes and commits `base.txt`, so changing it is a change to a tracked file,
  // which is what the working-tree card calls a change.
  await writeIn(repo, 'base.txt', 'the first line, changed\n');
  const shot = await frameWriter('commit');
  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    await expect(page.locator('[data-testid=wip-row]')).toContainText('1 changed');
    await shot(page, 'one change waiting');

    await page.getByRole('button', { name: 'stage', exact: true }).first().click();
    await expect(page.locator('[data-testid=unstage-button]')).toHaveCount(1);
    await shot(page, 'staged');

    await page.locator('[data-testid=commit-message]').fill('say what changed, and why');
    await shot(page, 'the message');

    await page.locator('[data-testid=commit-button]').click();
    await expect(page.locator('[data-testid=wip-row]')).toContainText('clean');
    await expect(page.locator('[data-testid=graph-count]')).toContainText('2 of 2 commits');
    await shot(page, 'committed, and the tree is clean');
  } finally {
    await closeApp(handle);
  }
});

test("a commit's own menu, and the confirmation behind it", async () => {
  const repo = await makeMenuRepo();
  const shot = await frameWriter('menu');
  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    await expect(page.locator('[data-testid=commit-row]')).toHaveCount(3);
    await shot(page, 'three commits');

    await page.locator('[data-testid=commit-row]').nth(1).click({ button: 'right' });
    await expect(page.locator('[data-testid=commit-menu]')).toBeVisible();
    await shot(page, 'the menu, on the commit that was clicked');

    // The destructive item is drawn red and does not run: it opens the sheet that asks for a
    // reason, which is the product's whole argument about destructive operations.
    await page.locator('[data-action=reset-hard]').click();
    await expect(page.locator('[role=dialog]')).toBeVisible();
    await shot(page, 'and what a destructive action asks for first');
  } finally {
    await closeApp(handle);
  }
});
