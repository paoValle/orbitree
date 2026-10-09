import { join } from 'node:path';
import {
  ConfirmationRequiredError,
  execute,
  openRepo,
  readCommit,
  readDiff,
  readGraph,
  readRefs,
  readStash,
  readStatus,
  riskOf,
} from '@orbitree/core';
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, shell } from 'electron';
import {
  CHANNELS,
  commitReadRequestSchema,
  diffRequestSchema,
  type Result,
  rememberRequestSchema,
  runRequestSchema,
  setHotkeyRequestSchema,
  stashRequestSchema,
  statusPathSchema,
  statusPayloadSchema,
} from '../shared/api.ts';
import { readState, writeState } from './state.ts';

const isDev = !app.isPackaged;

/**
 * Every IPC handler returns a `Result` instead of throwing: an exception across the
 * boundary arrives in the renderer as an opaque string, and the UI can do nothing with it.
 */
async function attempt<T>(work: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    const known = error instanceof Error ? error : new Error(String(error));
    return { ok: false, error: known.message, kind: known.name };
  }
}

function registerHandlers(): void {
  ipcMain.handle(CHANNELS.open, (_event, path: unknown) =>
    attempt(async () => {
      const repo = await openRepo(String(path));
      return { root: repo.root };
    }),
  );

  ipcMain.handle(CHANNELS.status, (_event, path: unknown) =>
    attempt(async () => {
      // Parsed, not cast: the renderer is a web page. The payload is checked on the way out
      // for the same reason, so nothing arrives shaped like a state it cannot name.
      const request = statusPathSchema.parse(path);
      const repo = await openRepo(request);
      return statusPayloadSchema.parse({ root: repo.root, state: await readStatus(repo) });
    }),
  );

  ipcMain.handle(CHANNELS.graph, (_event, request: unknown) =>
    attempt(async () => {
      const parsed = request as { path?: unknown; limit?: unknown; all?: unknown; rev?: unknown };
      const repo = await openRepo(String(parsed.path));
      const limit = Number.isInteger(parsed.limit) ? Number(parsed.limit) : 200;
      const data = await readGraph(repo, {
        limit,
        all: parsed.all === true,
        ...(typeof parsed.rev === 'string' && parsed.rev !== '' ? { rev: parsed.rev } : {}),
      });
      return { root: repo.root, data };
    }),
  );

  ipcMain.handle(CHANNELS.refs, (_event, path: unknown) =>
    attempt(async () => {
      const repo = await openRepo(String(path));
      return { root: repo.root, refs: await readRefs(repo) };
    }),
  );

  ipcMain.handle(CHANNELS.diff, (_event, request: unknown) =>
    attempt(async () => {
      const parsed = diffRequestSchema.parse(request);
      const repo = await openRepo(parsed.path);
      const files = await readDiff(repo, {
        ...(parsed.rev === undefined ? {} : { rev: parsed.rev }),
        ...(parsed.cached === true ? { cached: true } : {}),
      });
      return { root: repo.root, files };
    }),
  );

  ipcMain.handle(CHANNELS.commitRead, (_event, request: unknown) =>
    attempt(async () => {
      const parsed = commitReadRequestSchema.parse(request);
      const repo = await openRepo(parsed.path);
      return readCommit(repo, { rev: parsed.rev });
    }),
  );

  ipcMain.handle(CHANNELS.stash, (_event, path: unknown) =>
    attempt(async () => {
      // A string arrives, like on every other channel; the schema is for the value inside it.
      const repo = await openRepo(stashRequestSchema.parse({ path: String(path) }).path);
      return { root: repo.root, stashes: await readStash(repo) };
    }),
  );

  ipcMain.handle(CHANNELS.run, (_event, request: unknown) =>
    attempt(async () => {
      // Parse, do not cast: this is the boundary between a web page and a process that
      // can delete a working tree.
      const parsed = runRequestSchema.parse(request);
      const repo = await openRepo(parsed.path);
      const result = await execute(parsed.command, {
        cwd: repo.root,
        ...(parsed.confirm === undefined
          ? {}
          : {
              confirmation: {
                confirmedBy: 'desktop',
                reason: parsed.confirm,
                at: new Date().toISOString(),
              },
            }),
      });
      return {
        op: parsed.command.op,
        risk: riskOf(parsed.command),
        argv: result.argv,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
      };
    }),
  );

  ipcMain.handle(CHANNELS.stateRead, () => attempt(() => readState()));

  /**
   * Opening something is what puts it in the recents and makes it the one to reopen: one
   * channel, one read, one write.
   *
   * These used to be two channels, and they lost data: they were both fired from the same
   * renderer call, each read the file before the other wrote it, and whichever finished
   * second overwrote the first's change with the value it had read before it. The older
   * form had the list and the last pointer disagreeing with each other, which is a worse
   * failure than not persisting at all.
   */
  ipcMain.handle(CHANNELS.stateRemember, (_event, request: unknown) =>
    attempt(async () => {
      const { path } = rememberRequestSchema.parse(request);
      const state = await readState();
      const recents = [path, ...state.recents.filter((entry) => entry !== path)].slice(0, 12);
      const next = { ...state, recents, last: path };
      await writeState(next);
      return next;
    }),
  );

  ipcMain.handle(CHANNELS.stateSetHotkey, (_event, request: unknown) =>
    attempt(async () => {
      const { hotkey } = setHotkeyRequestSchema.parse(request);
      const state = await readState();
      const next = { ...state, hotkey };
      await writeState(next);
      await registerHotkey(next);
      return next;
    }),
  );

  ipcMain.handle(CHANNELS.pickDirectory, async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#0f1115',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      // The three settings that make a renderer an ordinary web page rather than a shell:
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  window.once('ready-to-show', () => window.show());
  // A repository can contain a link in a commit message; it opens in the real browser,
  // never inside the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devServer = process.env.ELECTRON_RENDERER_URL;
  const repo = repoFromArgv(process.argv);
  if (isDev && devServer !== undefined) {
    const url = new URL(devServer);
    if (repo !== null) url.searchParams.set('repo', repo);
    void window.loadURL(url.toString());
  } else {
    const renderer = join(import.meta.dirname, '../renderer/index.html');
    void (repo === null
      ? window.loadFile(renderer)
      : window.loadFile(renderer, { query: { repo } }));
  }
  return window;
}

/**
 * `--repo=<path>` on the command line is how a launcher (the test, a file manager, a shell)
 * opens a repository without clicking Browse. Everything after the first `=` is the path:
 * a repository path may contain `=`, so the value is not re-parsed.
 */
/**
 * The global hotkey, registered with the accelerator the person set.
 *
 * An invalid accelerator is refused rather than silently swallowed: `register` throws, and
 * the error is the answer, so a typo is something a person can read instead of a binding
 * that never fires. The default is `CommandOrControl+Alt+G`, which is also what the popup
 * window is bound to until someone changes it.
 */
async function registerHotkey(state: { hotkey: string | null }): Promise<void> {
  globalShortcut.unregisterAll();
  const accelerator = state.hotkey ?? 'CommandOrControl+Alt+G';
  try {
    globalShortcut.register(accelerator, () => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isMinimized()) window.restore();
        else if (window.isVisible()) window.hide();
        else window.show();
      }
    });
  } catch (error) {
    console.error(
      `orbitree: cannot register ${accelerator} (${error instanceof Error ? error.message : String(error)}); ` +
        'set another one in the settings',
    );
  }
}

function repoFromArgv(argv: readonly string[]): string | null {
  const prefix = '--repo=';
  for (const arg of argv) {
    if (arg.startsWith(prefix)) {
      const value = arg.slice(prefix.length);
      return value === '' ? null : value;
    }
  }
  return null;
}

app.whenReady().then(() => {
  registerHandlers();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Nothing in this app should ever reach the crash reporter with a token in it.
process.on('uncaughtException', (error) => {
  const message = error instanceof ConfirmationRequiredError ? error.message : error.message;
  console.error(`orbitree: ${message}`);
});
