import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  closeApp,
  launchApp,
  mainWindow,
  makeRepo,
  makeRunDir,
  orbitree,
  readStateFile,
} from './support.ts';

/**
 * Commands as data: the bar's buttons come from the user's file, and the sheet shows the argv the core
 * would build.
 *
 * The phase's exit criterion is the second half, and it is asserted here rather than inspected: the same
 * command resolved by `orbitree run --dry-run --json` and by the sheet's dry run have to be the same
 * line.
 */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

test('the bar is the user’s commands, and the sheet shows the argv the core builds', async () => {
  const repo = await makeRepo({ base: 'the base\n' });
  const userDataDir = await makeRunDir('userdata-');

  // A user's own file: one command this product ships, one of their own, and one entry with a typo in it
  // — which must cost the button and not the app.
  const custom = {
    recents: [],
    last: repo,
    hotkey: null,
    quickCommands: [
      {
        id: 'reset-hard',
        label: 'Throw the changes away',
        hint: 'their own words for it',
        command: { op: 'reset-hard', rev: 'HEAD' },
        danger: true,
      },
      {
        id: 'fetch',
        label: 'Get the remote',
        hint: 'fetch --prune',
        command: { op: 'fetch' },
        danger: false,
      },
      {
        id: 'broken',
        label: 'Not a command',
        hint: 'this one has no command at all',
        danger: false,
      },
    ],
  };
  const stateFile = join(userDataDir, 'state.json');
  await writeFile(stateFile, `${JSON.stringify(custom, null, 2)}\n`, 'utf8');

  const handle = await launchApp(repo, { userDataDir });
  try {
    const page = await mainWindow(handle.app);
    const bar = page.locator('.quickbar button.quick');

    // Their labels, in their order; the entry that does not parse is not a button, and the app is here.
    await expect(bar).toHaveCount(3); // the two commands and Refresh
    await expect(bar.nth(0)).toHaveText('Throw the changes away');
    await expect(bar.nth(1)).toHaveText('Get the remote');
    await expect(page.locator('.quickbar')).not.toContainText('Not a command');
    await expect(page.locator('[data-testid=graph-count]')).toContainText('commit');

    // The sheet shows what would run, from a dry run — not the hint the button carries.
    await bar.nth(0).click();
    const sheet = page.locator('[role=dialog]');
    await expect(sheet).toBeVisible();
    await expect(page.locator('[data-testid=sheet-argv]')).toHaveText('git reset --hard HEAD');
    await expect(sheet).not.toContainText('their own words for it');

    // The exit criterion: the CLI's dry run and the sheet print the same argv for the same button.
    const cli = await orbitree(
      ['run', repo, '--op', 'reset-hard', '--arg', 'HEAD', '--dry-run', '--json'],
      repo,
    );
    expect(cli.exitCode).toBe(0);
    const printed = JSON.parse(cli.stdout) as { data: { argv: readonly string[] } };
    await expect(page.locator('[data-testid=sheet-argv]')).toHaveText(
      `git ${printed.data.argv.join(' ')}`,
    );

    // Nothing ran: the sheet is a question, and the repository is where it was.
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);

    // The palette shows the same buttons, a keyboard away: the user's own first, and the shipped ones
    // that are also buttons are not repeated under another name.
    await page.keyboard.press(`${MOD}+k`);
    const items = page.locator('[data-testid=palette-item]');
    await expect(items.filter({ hasText: 'Throw the changes away' })).toHaveCount(1);
    const fetch = page.locator('[data-testid=palette-item][data-command-id="fetch"]');
    // One, and it is the user's: the shipped command with the same id is not listed a second time under
    // its own name, which is the difference between "the same commands" and "some of them twice".
    await expect(fetch).toHaveCount(1);
    await expect(fetch).toContainText('Get the remote');
    await page.keyboard.press('Escape');

    // The file is the user's: the app wrote its own fields back (it remembers the repository) and left
    // the commands exactly as they were written — including the entry that does not parse, which it does
    // not show and does not delete. A config the app silently rewrites is one whose next edit is blind.
    const after = await readStateFile(userDataDir);
    expect(after.quickCommands).toEqual(custom.quickCommands);

    await page.screenshot({
      path: join(import.meta.dirname, '..', '..', 'reports', 'commands.png'),
    });
  } finally {
    await closeApp(handle);
  }
});

test('a file with nothing in it means the commands this product ships', async () => {
  const repo = await makeRepo({ base: 'the base\n' });
  const userDataDir = await makeRunDir('userdata-');
  // A state file from an older version: it knows nothing about commands, so the shipped ones are what a
  // person sees — the same falling back the hotkey and the recents already do.
  await writeFile(
    join(userDataDir, 'state.json'),
    `${JSON.stringify({ recents: [], last: repo })}\n`,
  );

  const handle = await launchApp(repo, { userDataDir });
  try {
    const page = await mainWindow(handle.app);
    await expect(page.locator('.quickbar button.quick')).toHaveCount(8); // seven commands and Refresh
    await expect(page.locator('.quickbar')).toContainText('Fetch');
    // Nothing invented: the field the file did not have is written back as null — "nobody has said" —
    // rather than as a copy of what this product ships, which would freeze the defaults into a file.
    const written = await readFile(join(userDataDir, 'state.json'), 'utf8');
    expect(JSON.parse(written)).toMatchObject({ quickCommands: null });
  } finally {
    await closeApp(handle);
  }
});
