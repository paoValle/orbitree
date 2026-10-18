import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { closeApp, git, launchApp, mainWindow, makeRepo, writeIn } from './support.ts';

const run = promisify(execFile);

/**
 * A commit by somebody else.
 *
 * The fixture helper sets the author in the *environment*, so `git config user.name` cannot overrule
 * it — the same reason that helper sets it there. A test that wants two authors has to pass its own
 * environment, which is what this does.
 */
async function commitAs(repo: string, name: string, message: string): Promise<void> {
  await run('git', ['add', '-A'], { cwd: repo });
  await run('git', ['commit', '--quiet', '-m', message], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: `${name.toLowerCase().replace(/\s+/g, '.')}@example.invalid`,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: `${name.toLowerCase().replace(/\s+/g, '.')}@example.invalid`,
    },
  });
}

/**
 * Blame in the pane, and the jump from a line to its commit.
 *
 * The file is written in two commits by two authors, and the third line is left uncommitted: the three
 * cases a reader can be in. Every claim the pane makes is checked against `git` — the commit a line
 * came from, the author, and the fact that the graph really moved — because a pane that says
 * `a1b2c3d4` is a pane that could be saying anything.
 */
test('a file is blamed line by line, and a line jumps to its commit', async () => {
  // `base` is the fixture's own first commit, by the fixture's own author; the second commit is made
  // by another one, so "who wrote this line" has two possible answers and neither is assumed.
  const repo = await makeRepo({ base: 'first\nsecond\n' });
  await writeIn(repo, 'base.txt', 'first\nsecond\nthird\n');
  await commitAs(repo, 'Second Author', 'a third line');
  // And a line nobody has committed: it is in the working tree and in no commit at all.
  await writeIn(repo, 'base.txt', 'first\nsecond\nthird\nuncommitted\n');

  const handle = await launchApp(repo);
  try {
    const page = await mainWindow(handle.app);
    await page.locator('[data-testid=entry-item][data-path="base.txt"]').click();
    await page.locator('[data-testid=view-blame]').click();

    const lines = page.locator('[data-testid=blame-line]');
    await expect(lines).toHaveCount(4);
    await expect(lines.nth(0)).toContainText('first');
    await expect(lines.nth(2)).toContainText('third');

    // git's own answer for the same question, read a second way.
    const blamed = await git(repo, ['blame', '--porcelain', '--', 'base.txt']);
    const oids = blamed
      .split('\n')
      .map((line) => /^([0-9a-f]{40}) \d+ \d+/.exec(line)?.[1])
      .filter((oid): oid is string => oid !== undefined && !/^0+$/.test(oid));
    const latest = await git(repo, ['log', '--format=%H', '-1']);
    await expect(lines.nth(2)).toHaveAttribute('data-oid', latest);
    expect(oids).toContain(latest);
    // The authors are the ones git recorded, read from the commits rather than assumed: the fixture's
    // first commit has the fixture's author, and the second one has the one this test configured.
    const firstAuthor = (await git(repo, ['log', '--format=%an', '-1', 'HEAD~1'])).trim();
    expect(firstAuthor).not.toBe('Second Author');
    await expect(lines.nth(0)).toContainText(firstAuthor);
    await expect(lines.nth(2)).toContainText('Second Author');

    // The uncommitted line: git's own words, and no button, because there is nothing to jump to.
    await expect(lines.nth(3)).toContainText('Not Committed Yet');
    await expect(lines.nth(3).locator('[data-testid=blame-jump]')).toHaveCount(0);

    // The jump: the graph selects the commit the line came from, which is what the pane is for.
    await expect(page.locator('[data-testid=commit-row-selected]')).toHaveCount(0);
    await lines.nth(2).locator('[data-testid=blame-jump]').click();
    await expect(page.locator('[data-testid=commit-row-selected]')).toHaveAttribute(
      'data-hash',
      latest,
    );

    await page.screenshot({
      path: join(import.meta.dirname, '..', '..', 'reports', 'blame.png'),
    });

    // And the pane's own content is the file's content: blame of an unmodified file is the file.
    const onDisk = (await readFile(resolve(repo, 'base.txt'), 'utf8')).split('\n').slice(0, 4);
    for (const [index, text] of onDisk.entries()) {
      await expect(lines.nth(index)).toContainText(text);
    }
  } finally {
    await closeApp(handle);
  }
});
