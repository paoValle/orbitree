import { rm } from 'node:fs/promises';
import { _electron as electron, expect, type Page, test } from '@playwright/test';
import { APP_PATH, commit, makeRepo, writeIn } from './support.ts';

function renderedHashes(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid=commit-row]')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-hash') ?? ''));
}

/**
 * A repository with more commits than fit on screen, so the rendered window is measurable:
 * the count proves rows are windowed, and the changing hashes prove they are re-windowed on
 * scroll rather than merely covered up by the scroll container.
 */
test('a long history renders a window, not the whole log', async () => {
  const repo = await makeRepo();
  for (let index = 1; index <= 60; index += 1) {
    await writeIn(repo, 'log.txt', `${index}\n`);
    await commit(repo, `commit ${index}`);
  }

  const app = await electron.launch({
    args: [APP_PATH, `--repo=${repo}`],
    cwd: APP_PATH,
  });

  try {
    const page = await app.firstWindow();
    await expect(page.locator('[data-testid=graph-count]')).toContainText('60 commits');

    const rows = page.locator('[data-testid=commit-row]');
    await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(10);
    expect(await rows.count()).toBeLessThan(60);

    const before = await renderedHashes(page);
    await page.locator('[data-testid=graph-scroll]').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect
      .poll(async () => (await renderedHashes(page)).join('|'))
      .not.toBe(before.join('|'));
    expect(await renderedHashes(page)).not.toEqual(before);
  } finally {
    await app.close();
    await rm(repo, { recursive: true, force: true });
  }
});
