import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { APP_PATH, closeApp, git, launchApp } from './support.ts';

const run = promisify(execFile);
const repoRoot = resolve(APP_PATH, '..', '..');
const makeBigRepo = join(repoRoot, 'bin', 'make-big-repo.sh');

/** The repository is built by the committed script, so the expected numbers are git's. */
async function buildBigRepo(base: string, name: string, commits: string, every: string) {
  const repo = join(base, name);
  await run('bash', [makeBigRepo, repo, commits, every], { cwd: repoRoot });
  return repo;
}

function lines(output: string): string[] {
  return output.split('\n').filter((line) => line !== '');
}

test('the ref filter reads the history it names', async () => {
  test.setTimeout(180_000);
  const base = await mkdtemp(join(tmpdir(), 'orbitree-controls-'));
  const repo = await buildBigRepo(base, 'filtered', '40', '25');

  const allCount = Number(await git(repo, ['rev-list', '--count', '--all']));
  const feature = lines(await git(repo, ['branch', '--format=%(refname:short)'])).find((name) =>
    name.startsWith('feature-'),
  );
  if (feature === undefined) throw new Error('the fixture has no merged feature branch');
  const featureCount = Number(await git(repo, ['rev-list', '--count', feature]));
  const featureHashes = new Set(lines(await git(repo, ['rev-list', feature])));
  const tip = (await git(repo, ['rev-parse', feature])).trim();
  expect(featureCount).toBeLessThan(allCount);

  const handle = await launchApp(repo);
  try {
    const page = await handle.app.firstWindow();

    // `*` is every ref, which is what `--all` counts.
    await expect(page.locator('[data-testid=graph-count]')).toContainText(
      `${allCount} of ${allCount} commits`,
    );

    await page.selectOption('[data-testid=ref-filter]', { label: feature });
    await expect(page.locator('[data-testid=graph-count]')).toContainText(
      `${featureCount} of ${featureCount} commits`,
    );

    // The first row of the new history is selected, and the select released focus so the
    // pane is keyboard-usable again instead of the arrow keys changing the filter.
    const selected = page.locator('[data-testid=commit-row-selected]');
    await expect(selected).toHaveAttribute('data-hash', tip);
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? ''),
    ).toBe('graph-scroll');
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => selected.getAttribute('data-hash')).not.toBe(tip);

    const rows = page.locator('[data-testid=commit-row]');
    await expect(rows.first()).toBeVisible();
    const rendered = await rows.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-hash') ?? ''),
    );
    expect(rendered.length).toBeGreaterThan(0);
    for (const hash of rendered) expect(featureHashes.has(hash)).toBe(true);

    const screenshot = resolve('reports/graph-controls.png');
    await mkdir(dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot });
    console.log(`screenshot: ${screenshot}`);
  } finally {
    await closeApp(handle);
    await rm(base, { recursive: true, force: true });
  }
});

test('load more extends the window by a page', async () => {
  test.setTimeout(180_000);
  const base = await mkdtemp(join(tmpdir(), 'orbitree-controls-'));
  const repo = await buildBigRepo(base, 'big', '310', '200');

  const total = Number(await git(repo, ['rev-list', '--count', '--all']));
  expect(total).toBeGreaterThan(300);

  const handle = await launchApp(repo);
  try {
    const page = await handle.app.firstWindow();
    const count = page.locator('[data-testid=graph-count]');
    const loadMore = page.locator('[data-testid=load-more]');

    await expect(count).toContainText(`300 of ${total} commits`);
    await expect(loadMore).toBeVisible();
    await expect(loadMore).toHaveText('Load 300 more');

    await loadMore.click();
    await expect(count).toContainText(`${total} of ${total} commits`);
    await expect(loadMore).toHaveCount(0);

    // The full history is now in the data, but only the viewport is in the DOM: the window
    // is still a window.
    const rendered = await page.locator('[data-testid=commit-row]').count();
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(total);
  } finally {
    await closeApp(handle);
    await rm(base, { recursive: true, force: true });
  }
});
