import { join } from 'node:path';
import {
  ConfirmationRequiredError,
  execute,
  openRepo,
  readCommit,
  readDiff,
  readGraph,
  readRefs,
  readStatus,
  riskOf,
} from '@orbitree/core';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import {
  CHANNELS,
  commitReadRequestSchema,
  diffRequestSchema,
  type Result,
  runRequestSchema,
  statusPathSchema,
  statusPayloadSchema,
} from '../shared/api.ts';

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
