import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { closeApp, commit, git, launchApp, mainWindow, makeRepo, writeIn } from './support.ts';

/**
 * Comparing a branch with the one that is checked out.
 *
 * The fixture forks and then **cherry-picks** across the fork, because that is the case a set
 * difference of two hash lists gets wrong: the picked commit is on both sides as *work*, so it belongs
 * to neither list. Every assertion is `git`'s own answer — `--left-only` and `--right-only` — rather
 * than the card's, which is the thing under test.
 */
test('a branch is compared with the current one, both ways, and a row jumps to its commit', async () => {
  const repo = await makeRepo({ base: 'the base\n' });
  // Mine: two commits of its own, and it is checked out, so it is "mine" when the other is compared.
  await git(repo, ['checkout', '--quiet', '-b', 'mine']);
  await writeIn(repo, 'mine.txt', 'mine\n');
  await commit(repo, 'picked across to theirs');
  await writeIn(repo, 'mine.txt', 'mine\nmore mine\n');
  await commit(repo, 'only on mine');
  // Theirs: a commit of its own, and the first of mine picked across — which is the case a set
  // difference of two hash lists reports as two commits on each side.
  await git(repo, ['checkout', '--quiet', 'main']);
  await git(repo, ['checkout', '--quiet', '-b', 'theirs']);
  await writeIn(repo, 'theirs.txt', 'theirs\n');
  await commit(repo, 'only on theirs');
  await git(repo, ['cherry-pick', '--quiet', 'mine~1']);
  await git(repo, ['checkout', '--quiet', 'mine']);

  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    const row = (name: string) => page.locator(`[data-testid=ref-row][data-ref="${name}"]`);

    // Comparing a branch with itself is an empty answer, so the current branch's own button is off.
    await expect(row('mine').locator('[data-testid=ref-compare]')).toBeDisabled();
    await row('theirs').locator('[data-testid=ref-compare]').click();

    const card = page.locator('[data-testid=compare-card]');
    await expect(card).toBeVisible();
    await expect(page.locator('[data-testid=compare-summary]')).toContainText('only on');
    await expect(card).toContainText('mine');
    await expect(card).toContainText('theirs');

    // git's own answer for the same question, read a second way.
    const leftOnly = (
      await git(repo, ['log', '--left-only', '--cherry-pick', '--format=%H', 'mine...theirs'])
    )
      .split('\n')
      .filter((line) => line !== '');
    const rightOnly = (
      await git(repo, ['log', '--right-only', '--cherry-pick', '--format=%H', 'mine...theirs'])
    )
      .split('\n')
      .filter((line) => line !== '');

    const left = page.locator('[data-testid=compare-list][data-side=left]');
    const right = page.locator('[data-testid=compare-list][data-side=right]');
    await expect(left.locator('[data-testid=compare-row]')).toHaveCount(leftOnly.length);
    await expect(right.locator('[data-testid=compare-row]')).toHaveCount(rightOnly.length);
    // One commit each, and the picked one in neither list: it is on both sides as *work*, so a hash
    // difference would report it twice and this reports it not at all.
    expect(leftOnly).toHaveLength(1);
    expect(rightOnly).toHaveLength(1);
    await expect(left).toContainText('only on mine');
    await expect(right).toContainText('only on theirs');
    await expect(page.locator('[data-testid=compare-card]')).not.toContainText(
      'picked across to theirs',
    );
    await expect(left.locator('[data-testid=compare-row]').first()).toHaveAttribute(
      'data-hash',
      leftOnly[0] ?? '',
    );

    // The jump, the same one blame and history offer.
    await left.locator('[data-testid=compare-jump]').first().click();
    await expect(page.locator('[data-testid=commit-row-selected]')).toHaveAttribute(
      'data-hash',
      leftOnly[0] ?? '',
    );

    await page.screenshot({
      path: join(import.meta.dirname, '..', '..', 'reports', 'compare.png'),
    });
  } finally {
    await closeApp(handle);
  }
});
