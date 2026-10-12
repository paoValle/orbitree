import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { APP_PATH, closeApp, launchApp, mainWindow, makeRunDir } from './support.ts';

const run = promisify(execFile);

/**
 * P1's UI half, measured on a real window. The repository is built by the committed
 * script, not by the product, and it is deliberately smaller than the 1900-commit one the
 * CLI is measured on: a test that takes a minute is a test that gets skipped.
 */
test('@perf the window opens a large repository and draws a window, not the whole log', async () => {
  test.setTimeout(180_000);
  const repoRoot = resolve(APP_PATH, '..', '..');
  const base = await makeRunDir('orbitree-perf-');
  // A repository can be supplied so the same measurement runs at a size the test cannot
  // afford to build: `bash bin/make-big-repo.sh /tmp/big 1900 25` then
  // `ORBITREE_PERF_REPO=/tmp/big make perf`. The default stays small, because a test that
  // takes a minute is a test that gets skipped.
  const supplied = process.env.ORBITREE_PERF_REPO;
  const repo = supplied ?? join(base, 'bigrepo');
  if (supplied === undefined) {
    const built = await run(
      'bash',
      [join(repoRoot, 'bin', 'make-big-repo.sh'), repo, '600', '25'],
      {
        cwd: repoRoot,
      },
    );
    console.log(`[perf] built: ${built.stdout.trim().replace(/\n/g, ' ')}`);
  } else {
    console.log(`[perf] repository supplied: ${repo}`);
  }

  const started = Date.now();
  const handle = await launchApp(repo);
  const app = handle.app;
  try {
    const page = await mainWindow(app);
    await expect(page.locator('[data-testid=graph-count]')).toBeVisible();
    const firstDrawMs = Date.now() - started;
    console.log(`[perf] time to first draw = ${firstDrawMs} ms`);

    const countText = (await page.locator('[data-testid=graph-count]').innerText()).trim();
    const windowed = /^(\d+) of (\d+) commits/.exec(countText);
    if (windowed === null) throw new Error(`the graph count is not a window: ${countText}`);
    const total = Number(windowed[2]);

    const rendered = await page.locator('[data-testid=commit-row]').count();
    console.log(`[perf] rendered rows = ${rendered} of ${total}`);

    const screenshot = resolve('reports/big-repo.png');
    await mkdir(dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot });
    console.log(`[perf] screenshot: ${screenshot}`);

    const scrollStart = Date.now();
    await page.locator('[data-testid=graph-scroll]').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.waitForFunction(() => {
      const scroll = document.querySelector<HTMLElement>('[data-testid=graph-scroll]');
      if (scroll === null) return false;
      const rows = [...scroll.querySelectorAll<HTMLElement>('[data-testid=commit-row]')];
      if (rows.length === 0) return false;
      const tops = rows.map((row) => row.offsetTop);
      const maxTop = Math.max(...tops);
      const lastHeight = rows[tops.indexOf(maxTop)]?.offsetHeight ?? 0;
      // The window has re-rendered all the way to the last commit when the lowest row sits
      // at the bottom of the scrollable content, not merely when the scrollbar moved.
      return (
        scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 1 &&
        maxTop === scroll.scrollHeight - lastHeight
      );
    });
    const scrollMs = Date.now() - scrollStart;
    console.log(`[perf] scroll to the end = ${scrollMs} ms`);

    // Generous enough for a busy machine, tight enough that a real regression fails them:
    // 5 s to first paint is already far past "feels instant".
    expect(firstDrawMs).toBeLessThan(5000);
    expect(scrollMs).toBeLessThan(1000);
    expect(rendered).toBeLessThan(total);
    expect(rendered).toBeGreaterThanOrEqual(10);
  } finally {
    await closeApp(handle);
    await rm(base, { recursive: true, force: true });
  }
});
