import { join } from 'node:path';
import {
  BEFORE_NOTHING,
  ConfirmationRequiredError,
  execute,
  openRepo,
  readCommit,
  readConflictRegions,
  readConflictSide,
  readDiff,
  readGraph,
  readRefs,
  readStash,
  readStashPatch,
  readStatus,
  reverseOf,
  toArgv,
  riskOf,
} from '@orbitree/core';
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  screen,
  shell,
  Tray,
} from 'electron';
import {
  CHANNELS,
  commitReadRequestSchema,
  diffRequestSchema,
  forgetLastRequestSchema,
  type Result,
  rememberRequestSchema,
  runRequestSchema,
  setHotkeyRequestSchema,
  conflictRegionRequestSchema,
  conflictSideRequestSchema,
  stashPatchRequestSchema,
  stashRequestSchema,
  statusPathSchema,
  statusPayloadSchema,
} from '../shared/api.ts';
import { mutateState, readState } from './state.ts';

const isDev = !app.isPackaged;

/** The tray icon, written by `apps/desktop/scripts/make-icon.mjs` rather than committed. */
const ICON = join(import.meta.dirname, '..', 'assets', 'tray.png');

/**
 * Set by the tray's Quit: the only thing that turns a close into a quit. A module-level
 * flag rather than state on the window, because the window is what it is closing.
 */
let reallyQuitting = false;

let popup: BrowserWindow | null = null;

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
      const parsed = request as {
        path?: unknown;
        limit?: unknown;
        all?: unknown;
        rev?: unknown;
        hide?: unknown;
      };
      const repo = await openRepo(String(parsed.path));
      const limit = Number.isInteger(parsed.limit) ? Number(parsed.limit) : 200;
      const data = await readGraph(repo, {
        limit,
        all: parsed.all === true,
        ...(typeof parsed.rev === 'string' && parsed.rev !== '' ? { rev: parsed.rev } : {}),
        // Names, checked one by one: the renderer is a web page, and this is the list the picture
        // will be missing.
        ...(Array.isArray(parsed.hide) && parsed.hide.length > 0
          ? { hide: parsed.hide.filter((name): name is string => typeof name === 'string') }
          : {}),
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

  ipcMain.handle(CHANNELS.conflictRegions, (_event, request: unknown) =>
    attempt(async () => {
      const parsed = conflictRegionRequestSchema.parse(request);
      const repo = await openRepo(parsed.path);
      const regions = await readConflictRegions(repo, { path: parsed.file });
      return { root: repo.root, path: parsed.file, regions };
    }),
  );

  ipcMain.handle(CHANNELS.conflictSide, (_event, request: unknown) =>
    attempt(async () => {
      const parsed = conflictSideRequestSchema.parse(request);
      const repo = await openRepo(parsed.path);
      const content = await readConflictSide(repo, { path: parsed.file, side: parsed.side });
      return { root: repo.root, side: parsed.side, path: parsed.file, content };
    }),
  );

  ipcMain.handle(CHANNELS.stashPatch, (_event, request: unknown) =>
    attempt(async () => {
      const parsed = stashPatchRequestSchema.parse(request);
      const repo = await openRepo(parsed.path);
      return { root: repo.root, files: await readStashPatch(repo, { selector: parsed.selector }) };
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
      // Built here rather than in the window, because the core is what knows what reverses what:
      // the window sends the state, the process that can run git names the command — and knows
      // whether running it would need a reason.
      const reverse = reverseOf(parsed.command, parsed.before ?? BEFORE_NOTHING);
      return {
        op: parsed.command.op,
        risk: riskOf(parsed.command),
        argv: result.argv,
        reverse:
          reverse === null
            ? null
            : { command: reverse, argv: toArgv(reverse), risk: riskOf(reverse) },
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
      return mutateState((state) => {
        const recents = [path, ...state.recents.filter((entry) => entry !== path)].slice(0, 12);
        return { ...state, recents, last: path };
      });
    }),
  );

  ipcMain.handle(CHANNELS.stateForgetLast, (_event, request: unknown) =>
    attempt(async () => {
      const { path } = forgetLastRequestSchema.parse(request);
      // Only `last`. The path stays in the recents list, because a volume that is not mounted yet
      // is not a repository that has gone for good, and a list that forgets is a list nobody can
      // trust. What is cleared is what the app would reopen by itself, which would fail again on
      // every launch.
      return mutateState((state) => (state.last === path ? { ...state, last: null } : state));
    }),
  );

  ipcMain.handle(CHANNELS.stateSetHotkey, (_event, request: unknown) =>
    attempt(async () => {
      const { hotkey } = setHotkeyRequestSchema.parse(request);
      const next = await mutateState((state) => ({ ...state, hotkey }));
      await registerHotkey(next);
      return next;
    }),
  );

  // The hotkey and the tray menu both open the quick window; this is the same action, so a
  // caller that cannot press a global key (the E2E suite, on a runner where the registration
  // is refused) can still ask for it.
  ipcMain.handle(CHANNELS.togglePopup, () => attempt(() => togglePopup()));

  ipcMain.handle(CHANNELS.showWindow, () =>
    attempt(async () => {
      const window = BrowserWindow.getAllWindows().find((candidate) => candidate !== popup);
      if (window === undefined) return false;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      return true;
    }),
  );

  ipcMain.handle(CHANNELS.pickDirectory, async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
}

function createWindow(): BrowserWindow {
  const quiet = isQuiet(process.argv);
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

  /**
   * Closing the window is not quitting the app.
   *
   * The window hides and the tray icon keeps the app alive, which is the same promise the
   * dock makes on macOS already. `reallyQuitting` is the one way out: the tray's Quit, and
   * nothing else, because an app that cannot be closed over a repository it will not let go
   * of is worse than one that closes.
   */
  window.on('close', (event) => {
    if (reallyQuitting) return;
    event.preventDefault();
    window.hide();
  });

  // Never shown in a quiet run: the renderer still paints, so the DOM, the assertions and the
  // screenshots are unaffected, and no window can steal focus.
  if (!quiet) window.once('ready-to-show', () => window.show());
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
  // A global shortcut is registered system-wide: a test run must not take a key combination away
  // from the person using the machine.
  if (isQuiet(process.argv)) return;
  const accelerator = state.hotkey ?? 'CommandOrControl+Alt+G';
  try {
    globalShortcut.register(accelerator, () => {
      void togglePopup();
    });
  } catch (error) {
    console.error(
      `orbitree: cannot register ${accelerator} (${error instanceof Error ? error.message : String(error)}); ` +
        'set another one in the settings',
    );
  }
}

/**
 * `--quiet` is for the test suite, and it exists because a test run should not take over the
 * machine it runs on: a window that appears and steals focus from whatever the person was doing,
 * a global hotkey that swallows their keystrokes, a Dock icon, a menu-bar icon.
 *
 * The window is still created and still renders — the specs assert on the real DOM and take real
 * screenshots — it is simply never shown. `--tray` opts back into the tray, for the one spec that
 * is about the tray.
 */
function isQuiet(argv: readonly string[]): boolean {
  return argv.includes('--quiet');
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

app.whenReady().then(async () => {
  registerHandlers();
  createWindow();
  // The tray is a menu-bar icon, so a quiet run keeps it off unless the spec is about the tray.
  if (!isQuiet(process.argv) || process.argv.includes('--tray')) tryTray();
  // No Dock icon either: on macOS a running app with a window it never shows is still an icon
  // in the Dock and a name in the app switcher.
  if (isQuiet(process.argv)) app.dock?.hide();
  createPopupWindow();
  // The hotkey is registered from what the person last set, before anything else can ask for
  // a different one.
  await registerHotkey(await readState());
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/**
 * The tray: where the app lives when its window does not.
 *
 * A click restores the window, and the menu offers the one thing a person who hides an app
 * wants, which is a way to actually quit it. On macOS the app also stays in the dock when
 * every window is closed, which is the platform's own convention; on the other two the
 * tray icon is what keeps the process alive.
 */
/**
 * The tray, without letting it take the app down with it.
 *
 * An icon that will not load is a missing icon, and the app still has a window, a hotkey
 * and a popup. Letting the throw out of `whenReady` would leave the whole shell unstarted
 * for something cosmetic, which is what it did on the first run.
 */
function tryTray(): void {
  try {
    createTray();
  } catch (error) {
    console.error(
      `orbitree: no tray icon (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function createTray(): void {
  const tray = new Tray(ICON);
  tray.setToolTip('orbitree');

  const show = (): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  };

  tray.on('click', show);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show orbitree', click: show },
      {
        label: 'Open the quick window',
        click: () => {
          void togglePopup();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          reallyQuitting = true;
          app.quit();
        },
      },
    ]),
  );
}

/**
 * The quick window: a compact panel over the current repository, toggled by the global
 * hotkey and shown above the main window when it is open.
 *
 * It loads the same renderer as the app, with a query parameter that asks for the compact
 * layout, so there is one implementation of the panes and no second copy of any of it.
 */
function createPopupWindow(): void {
  popup = new BrowserWindow({
    width: 420,
    height: 360,
    show: false,
    frame: false,
    alwaysOnTop: true,
    backgroundColor: '#161a21',
    skipTaskbar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (isDev && devServer !== undefined) {
    void popup.loadURL(`${devServer}?popup=1`);
  } else {
    void popup.loadFile(join(import.meta.dirname, '..', 'renderer', 'index.html'), {
      query: { popup: '1' },
    });
  }

  // Clicking away is how a quick window closes; keeping focus would trap the person.
  popup.on('blur', () => popup?.hide());
}

async function togglePopup(): Promise<void> {
  if (popup === null || popup.isVisible()) {
    popup?.hide();
    return;
  }
  const cursor = screen.getCursorScreenPoint();
  const bounds = popup.getBounds();
  // Opened beside the cursor rather than wherever it was left: a quick window that appears
  // under the pointer is one you have to chase.
  popup.setBounds({
    x: Math.max(0, cursor.x - bounds.width + 24),
    y: Math.max(0, cursor.y - bounds.height - 8),
    width: bounds.width,
    height: bounds.height,
  });
  popup.show();
  popup.focus();
  // The panel reads the repository as it appears, rather than as it started: nobody can
  // promise the main window was quiet while the quick window was hidden.
  popup.webContents.send(CHANNELS.popupShown);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Nothing in this app should ever reach the crash reporter with a token in it.
process.on('uncaughtException', (error) => {
  const message = error instanceof ConfirmationRequiredError ? error.message : error.message;
  console.error(`orbitree: ${message}`);
});
