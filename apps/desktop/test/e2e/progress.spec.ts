import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  closeApp,
  commit,
  git,
  launchApp,
  mainWindow,
  makeRepo,
  makeRunDir,
  writeIn,
} from './support.ts';

/**
 * A fetch says it is moving.
 *
 * The remote is a **bare repository beside the fixture, reached by `file://`**: no network is needed,
 * and the URL scheme matters — git optimises a fetch from a plain path away and would then report
 * nothing at all. With the scheme it packs and sends objects, and reports them, which is what this
 * test is about.
 *
 * The line is asserted after the fetch has finished, because it is kept until the next command
 * starts: "Receiving objects 100%" is the answer to whether the fetch worked, and asserting it during
 * a fetch of ten objects would be a race against a fetch that takes 200 ms.
 */
test('a fetch reports what git is doing, in the bar it was asked from', async () => {
  const beside = await makeRunDir('progress-');
  const repo = await makeRepo({ base: 'the first line\n' });
  const bare = join(beside, 'remote.git');
  // `-b main`: a bare repository's HEAD decides what a fetch of it resolves, and without this it
  // is the machine's `init.defaultBranch`, which is `master` on a CI runner and `main` here.
  await git(beside, ['init', '--bare', '-b', 'main', '--quiet', bare]);
  // `origin` pointed at the bare repository and nothing else anywhere: the fixture's history is what
  // the fetch has to move, and the URL scheme is what makes git pack it and report doing so.
  await git(repo, ['remote', 'add', 'origin', `file://${bare}`]);
  await git(repo, ['push', '--quiet', 'origin', 'main']);

  // The remote moves on, so the fetch has objects to receive: a fetch of nothing reports nothing,
  // which is git being right and this test asserting the wrong thing.
  const other = join(beside, 'other');
  await git(beside, ['clone', '--quiet', bare, other]);
  await git(other, ['config', 'user.name', 'E2E Elsewhere']);
  await git(other, ['config', 'user.email', 'elsewhere@example.invalid']);
  await writeIn(other, 'beside.txt', 'made somewhere else\n');
  await commit(other, 'a commit made somewhere else');
  await git(other, ['push', '--quiet', 'origin', 'main']);

  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    await page.getByRole('button', { name: 'Fetch', exact: true }).click();

    const progress = page.locator('[data-testid=run-progress]');
    await expect(progress).toBeVisible({ timeout: 20_000 });
    // git's own phase names, and a percentage or a count: what came back is a line this product
    // parsed, not the raw stderr it would otherwise show.
    await expect(progress).toContainText(
      /Compressing objects|Counting objects|Receiving objects|Resolving deltas/,
    );
    // And the fetch really happened: git's own answer in the repository it was run in, rather than
    // the line the window drew.
    expect(await git(repo, ['branch', '--remotes'])).toContain('origin/main');

    await page.screenshot({
      path: join(import.meta.dirname, '..', '..', 'reports', 'progress.png'),
    });
  } finally {
    await closeApp(handle);
    await rm(beside, { recursive: true, force: true });
  }
});
