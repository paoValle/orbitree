import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, type Page, test } from '@playwright/test';
import { closeApp, commit, git, launchApp, makeRepo, writeIn } from './support.ts';

const run = promisify(execFile);

const FILE_KINDS = [
  'code',
  'shell',
  'markdown',
  'text',
  'json',
  'config',
  'image',
  'binary',
  'other',
] as const;

const FILE_ICONS = [
  'file-code',
  'file-shell',
  'file-markdown',
  'file-text',
  'file-json',
  'file-config',
  'file-image',
  'file-binary',
] as const;

/**
 * `git` in support.ts trims its output, which would eat the leading space of a porcelain v1
 * record. The expected sections come from git's own `-z` output, untrimmed, so this test
 * compares the DOM against git rather than against a list typed here.
 */
async function porcelain(repo: string): Promise<Map<string, { x: string; y: string }>> {
  const { stdout } = await run('git', ['status', '--porcelain=v1', '-z'], {
    cwd: repo,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    maxBuffer: 32 * 1024 * 1024,
  });
  const records = stdout.split('\u0000').filter((record) => record !== '');
  const status = new Map<string, { x: string; y: string }>();
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i] as string;
    const x = record[0] ?? '';
    const y = record[1] ?? '';
    status.set(record.slice(3), { x, y });
    // A rename/copy record owns the next NUL-terminated field: the original path.
    if (x === 'R' || x === 'C') i += 1;
  }
  return status;
}

function pathsWhere(
  status: Map<string, { x: string; y: string }>,
  predicate: (pair: { x: string; y: string }) => boolean,
): string[] {
  return [...status]
    .filter(([, pair]) => predicate(pair))
    .map(([path]) => path)
    .sort();
}

async function sectionPaths(page: Page, section: string): Promise<string[]> {
  const items = page.locator(
    `[data-testid=wt-section][data-section="${section}"] [data-testid=entry-item]`,
  );
  const paths = await items.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-path') ?? ''),
  );
  return paths.sort();
}

test('the working tree pane separates staged from unstaged and diffs what you click', async () => {
  const repo = await makeRepo();
  await writeIn(repo, 'readme.md', '# readme\n');
  await writeIn(repo, 'staged-mod.md', 'original staged\n');
  await writeIn(repo, 'unstaged.txt', 'original unstaged\n');
  await writeIn(repo, 'both.json', '{ "side": "original" }\n');
  await commit(repo, 'base');

  // A staged new file and a staged modification: each has an index version and no working-tree
  // change of its own.
  await writeIn(repo, 'staged-new.ts', 'export const stagedNew = "STAGED_NEW_SENTINEL";\n');
  await writeIn(repo, 'staged-mod.md', 'staged modification STAGED_MOD_SENTINEL\n');
  await git(repo, ['add', 'staged-new.ts', 'staged-mod.md']);
  // An unstaged modification of a different file.
  await writeIn(repo, 'unstaged.txt', 'unstaged change UNSTAGED_SENTINEL\n');
  // The same file, changed in the index and then changed again in the working tree.
  await writeIn(repo, 'both.json', '{ "side": "INDEX_SENTINEL" }\n');
  await git(repo, ['add', 'both.json']);
  await writeIn(repo, 'both.json', '{ "side": "WORKTREE_SENTINEL" }\n');
  // Not in the index and not in any commit.
  await writeIn(repo, 'untracked.css', '.uno { color: UNTRACKED_SENTINEL; }\n');

  const status = await porcelain(repo);
  const stagedExpected = pathsWhere(status, (pair) => pair.x !== ' ' && pair.x !== '?');
  const unstagedExpected = pathsWhere(status, (pair) => pair.y !== ' ' && pair.y !== '?');
  const untrackedExpected = pathsWhere(status, (pair) => pair.x === '?');
  const conflictedExpected = pathsWhere(status, (pair) => pair.x === 'U' || pair.y === 'U');

  const handle = await launchApp(repo);
  try {
    const page = await handle.app.firstWindow();
    await expect(page.locator('[data-testid=working-tree]')).toBeVisible();

    // The sections that exist, in the pane's own order, are the ones git says have entries.
    const expectedSections = [
      stagedExpected.length > 0 ? 'staged' : null,
      unstagedExpected.length > 0 ? 'unstaged' : null,
      conflictedExpected.length > 0 ? 'conflicted' : null,
      untrackedExpected.length > 0 ? 'untracked' : null,
    ].filter((section): section is string => section !== null);
    // The panel exists before its status arrives; wait for the sections, not for the card.
    await expect(page.locator('[data-testid=wt-section]')).toHaveCount(expectedSections.length);
    const domSections = await page
      .locator('[data-testid=wt-section]')
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-section') ?? ''),
      );
    expect(domSections).toEqual(expectedSections);

    for (const [section, expected] of [
      ['staged', stagedExpected],
      ['unstaged', unstagedExpected],
      ['conflicted', conflictedExpected],
      ['untracked', untrackedExpected],
    ] as const) {
      expect(await sectionPaths(page, section), section).toEqual(expected);
    }
    // The double-modified file is in both, which is the point of the split.
    expect(stagedExpected).toContain('both.json');
    expect(unstagedExpected).toContain('both.json');
    expect(stagedExpected).not.toContain('unstaged.txt');

    // The staged-only file: the staged view is the only one that can show its content,
    // because the working tree has no change for it.
    await page
      .locator('[data-section=staged] [data-testid=entry-item][data-path="staged-new.ts"]')
      .click();
    const wtDiff = page.locator('[data-testid=wt-diff]');
    await expect(wtDiff).toContainText('STAGED_NEW_SENTINEL');

    // The unstaged file: this diff is the working tree against the index.
    await page
      .locator('[data-section=unstaged] [data-testid=entry-item][data-path="unstaged.txt"]')
      .click();
    await expect(wtDiff).toContainText('UNSTAGED_SENTINEL');

    // The double-modified file, twice. The staged side reads the index and shows the line
    // that only exists there; the changes side reads the working tree. They must differ.
    await page
      .locator('[data-section=staged] [data-testid=entry-item][data-path="both.json"]')
      .click();
    await expect(wtDiff).toContainText('INDEX_SENTINEL');
    const stagedBoth = await wtDiff.innerText();
    expect(stagedBoth).not.toContain('WORKTREE_SENTINEL');
    await page
      .locator('[data-section=unstaged] [data-testid=entry-item][data-path="both.json"]')
      .click();
    await expect(wtDiff).toContainText('WORKTREE_SENTINEL');
    const unstagedBoth = await wtDiff.innerText();
    expect(unstagedBoth).not.toBe(stagedBoth);

    // A screenshot with a real diff on screen, taken before the untracked explanation.
    const screenshot = resolve('reports/working-tree.png');
    await mkdir(dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot });
    console.log(`screenshot: ${screenshot}`);

    // An untracked file cannot be diffed: the pane explains itself in words.
    await page
      .locator('[data-section=untracked] [data-testid=entry-item][data-path="untracked.css"]')
      .click();
    await expect(wtDiff).toContainText('neither the index nor any commit');

    // Every entry says what kind of file it is, and the icon carries the name, not a drawing.
    const kinds = await page
      .locator('[data-testid=entry-item]')
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-kind') ?? ''),
      );
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) expect(FILE_KINDS).toContain(kind);
    expect(kinds.some((kind) => kind === 'code' || kind === 'markdown')).toBe(true);
    const icons = await page
      .locator('[data-testid=entry-kind] svg')
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-icon') ?? ''),
      );
    expect(icons.length).toBe(kinds.length);
    for (const icon of icons) expect(FILE_ICONS).toContain(icon);
  } finally {
    await closeApp(handle);
    await rm(repo, { recursive: true, force: true });
  }
});
