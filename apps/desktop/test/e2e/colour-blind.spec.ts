import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { closeApp, git, launchApp, mainWindow, makeRepo, makeRunDir, writeIn } from './support.ts';

/**
 * Colour is a second channel and never the only one.
 *
 * `docs/DESIGN.md` says a ref kind and a status kind carry a glyph as well as a colour, and that
 * every state is legible in a still screenshot. This is the picture that claim is judged on, taken
 * through a red-green colour blindness — and the two assertions above it pin the half a filter
 * cannot take away: the shape inside a badge, and the letter beside a file.
 *
 * The simulation is a colour matrix rather than a mock-up, so what is being judged is the real
 * window with its colours collapsed: the lane geometry, the glyphs and git's own letters are what
 * remain, and they are what a reader has to be left with.
 */
const DEUTERANOPIA = [
  '0.625 0.375 0.000 0 0',
  '0.700 0.300 0.000 0 0',
  '0.000 0.300 0.700 0 0',
  '0.000 0.000 0.000 1 0',
].join(' ');

test('every badge carries a shape, and the window survives a red-green blindness', async () => {
  const repo = await makeRepo({ base: 'the first line\n' });
  // A bare repository beside the run's own directory, so the row has a remote badge as well as a
  // branch, a tag and a stash. `git` runs with this directory as its working directory: spawning
  // in the bare repository would need it to exist first, which is what creating it does.
  const remoteDir = await makeRunDir('remote-');
  const bare = join(remoteDir, 'origin.git');
  await git(remoteDir, ['init', '--bare', '--quiet', bare]);
  await git(repo, ['remote', 'add', 'origin', bare]);
  await git(repo, ['push', '--quiet', '-u', 'origin', 'main']);
  await git(repo, ['tag', 'v0.1']);

  // A stash, and then a working tree with one of each kind waiting, so the screenshot holds a
  // badge of every sort the product draws and a status letter of every sort it prints.
  await writeIn(repo, 'base.txt', 'set aside in a stash\n');
  await git(repo, ['stash', 'push', '--quiet', '-m', 'work set aside']);
  await writeIn(repo, 'base.txt', 'changed in the working tree\n');
  await writeIn(repo, 'added.txt', 'staged\n');
  await git(repo, ['add', 'added.txt']);
  await writeIn(repo, 'untracked.txt', 'never added\n');

  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);

    // Every badge carries a glyph, which is the channel that survives when the colour does not.
    const badges = page.locator('.badge');
    // A branch, its remote, a tag and a stash: four kinds, so the loop below is not vacuous.
    await expect(badges).toHaveCount(4);
    for (let index = 0; index < 4; index += 1) {
      await expect(badges.nth(index).locator('svg')).toHaveCount(1);
    }

    // And every entry in the working tree is a glyph plus git's own letters, which no filter
    // takes away: the kind column is a drawing and the status column is text.
    const entries = page.locator('[data-testid=entry-item]');
    await expect(entries).toHaveCount(3);
    for (let index = 0; index < 3; index += 1) {
      await expect(entries.nth(index).locator('[data-testid=entry-kind] svg')).toHaveCount(1);
      await expect(entries.nth(index).locator('.status-code')).toHaveText(/^[A-Z?.]{1,2}$/);
    }

    await page.evaluate((values) => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('style', 'position:absolute;width:0;height:0');
      svg.innerHTML = `<filter id="colour-blindness"><feColorMatrix type="matrix" values="${values}" /></filter>`;
      document.body.append(svg);
      document.documentElement.style.filter = 'url(#colour-blindness)';
    }, DEUTERANOPIA);
    await page.waitForTimeout(200);

    const screenshot = resolve(import.meta.dirname, '..', '..', 'reports', 'colour-blind.png');
    await mkdir(dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot });
    console.log(`screenshot: ${screenshot}`);
  } finally {
    await closeApp(handle);
  }
});
