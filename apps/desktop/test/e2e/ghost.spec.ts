import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { closeApp, commit, git, launchApp, mainWindow, makeRepo, writeIn } from './support.ts';

/**
 * The ghost branch, and the commits of a name under the pointer.
 *
 * Both are about the *picture*: the first says which commit a double click would go to, the second says
 * which rows belong to a name. What they claim is checked against git — the head that moved, the commits
 * a branch reaches — because a highlight is a claim about history.
 */
test('a double click goes to the selected commit, and hovering a name highlights its commits', async () => {
  const repo = await makeRepo({ base: 'the base\n' });
  // A branch pointing at the *middle* commit of one line: selecting it gives the ghost a path to walk
  // (from the checked-out commit down to it), and its own commits are a strict subset of the picture, so
  // a highlight has something to include and something to leave out.
  await writeIn(repo, 'work.txt', 'work\n');
  await commit(repo, 'only on work');
  await git(repo, ['branch', 'work']);
  await writeIn(repo, 'main.txt', 'main\n');
  await commit(repo, 'only on main');
  const work = await git(repo, ['rev-parse', 'work']);
  const main = await git(repo, ['rev-parse', 'main']);
  const base = await git(repo, ['rev-parse', 'HEAD~2']);

  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    const rows = page.locator('[data-testid=commit-row]');

    // The ghost: the selected row wears a dashed badge with the commit a double click would go to, and
    // the path from the checked-out commit down to it is marked — the move, drawn before it is made.
    const workRow = rows.filter({ hasText: 'only on work' }).first();
    const rowFor = (hash: string) => page.locator(`[data-testid=commit-row][data-hash="${hash}"]`);

    await workRow.click();
    await expect(workRow.locator('[data-testid=ghost-badge]')).toHaveText(work.slice(0, 7));
    await expect(rowFor(main)).toHaveAttribute('data-ghost', 'yes');
    await expect(rowFor(work)).toHaveAttribute('data-ghost', 'yes');
    // The commit before the branch point is not on the path: the ghost stops where the selection is.
    await expect(rowFor(base)).toHaveAttribute('data-ghost', 'no');

    // The jump: a double click on a row checks that commit out, which git is asked about — there is no
    // branch to name afterwards.
    await workRow.click();
    await workRow.dblclick();
    await expect.poll(() => git(repo, ['rev-parse', 'HEAD'])).toBe(work);
    await expect
      .poll(() => git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''))
      .toBe('');

    // The highlight: hovering a name marks the rows it can reach, and only those. Cross-checked by asking
    // git which commits each branch has.
    const onWork = (await git(repo, ['rev-list', 'work']))
      .split('\n')
      .filter((line) => line !== '');
    const onMain = (await git(repo, ['rev-list', 'main']))
      .split('\n')
      .filter((line) => line !== '');
    expect(onWork).toContain(work);
    expect(onMain).toContain(main);
    expect(onWork).not.toContain(main);

    await expect(rowFor(work)).toHaveAttribute('data-highlighted', 'no');
    // `work` reaches its own commit and the base, and not the commit on main above it: a name's commits
    // are everything it reaches, and no more.
    await page.locator('[data-testid=ref-row][data-ref="work"]').hover();
    await expect(rowFor(work)).toHaveAttribute('data-highlighted', 'yes');
    await expect(rowFor(base)).toHaveAttribute('data-highlighted', 'yes');
    await expect(rowFor(main)).toHaveAttribute('data-highlighted', 'no');

    await page.screenshot({
      path: join(import.meta.dirname, '..', '..', 'reports', 'ghost.png'),
    });

    // Leaving the row takes it back: a highlight that stayed would be a second selection.
    await page.locator('[data-testid=ref-row][data-ref="main"]').hover();
    await expect(rowFor(main)).toHaveAttribute('data-highlighted', 'yes');
    await expect(rowFor(work)).toHaveAttribute('data-highlighted', 'yes');
  } finally {
    await closeApp(handle);
  }
});
