import { join, resolve, sep } from 'node:path';
import {
  BEFORE_NOTHING,
  ConfirmationRequiredError,
  diagnoseFailure,
  execute,
  InvalidArgumentError,
  openRepo,
  redact,
  readBlame,
  readCommit,
  readComparison,
  readConflictRegions,
  readConflictSide,
  readDiff,
  readGraph,
  readIdentity,
  readRefs,
  readRemotes,
  readStash,
  readStashPatch,
  readWorktrees,
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
  blameRequestSchema,
  CHANNELS,
  compareRequestSchema,
  fileActionSchema,
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
        /** One file, for its own history: `path` here is already the repository. */
        file?: unknown;
        grep?: unknown;
        author?: unknown;
        since?: unknown;
        until?: unknown;
        hide?: unknown;
      };
      const repo = await openRepo(String(parsed.path));
      const limit = Number.isInteger(parsed.limit) ? Number(parsed.limit) : 200;
      const data = await readGraph(repo, {
        limit,
        all: parsed.all === true,
        // The window draws a name's commits under the pointer, so it is the caller that needs this and
        // not the CLI: the map is off unless a caller asks for it.
        reachable: true,
        ...(typeof parsed.rev === 'string' && parsed.rev !== '' ? { rev: parsed.rev } : {}),
        ...(typeof parsed.file === 'string' && parsed.file !== '' ? { path: parsed.file } : {}),
        // Search fields, checked one by one like every other value from a web page: a non-string is
        // dropped rather than coerced into a filter nobody asked for.
        ...(typeof parsed.grep === 'string' && parsed.grep !== '' ? { grep: parsed.grep } : {}),
        ...(typeof parsed.author === 'string' && parsed.author !== ''
          ? { author: parsed.author }
          : {}),
        ...(typeof parsed.since === 'string' && parsed.since !== '' ? { since: parsed.since } : {}),
        ...(typeof parsed.until === 'string' && parsed.until !== '' ? { until: parsed.until } : {}),
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

  /**
   * One file of one repository, resolved against the repository it belongs to.
   *
   * The renderer is a web page, so the path it sends is a *file inside the repository* and nothing
   * else: resolved against the root and refused when it escapes, which is what stops a page from asking
   * the operating system to open something it was never shown.
   */
  const insideRepository = async (request: unknown): Promise<{ root: string; full: string }> => {
    const parsed = fileActionSchema.parse(request);
    const repo = await openRepo(parsed.path);
    const full = resolve(repo.root, parsed.file);
    if (full !== repo.root && !full.startsWith(repo.root + sep)) {
      throw new InvalidArgumentError(`${parsed.file} is outside the repository`);
    }
    return { root: repo.root, full };
  };

  ipcMain.handle(CHANNELS.openFile, (_event, request: unknown) =>
    attempt(async () => {
      const { full } = await insideRepository(request);
      // `openPath` answers with the error it hit rather than throwing, which is a string to return or
      // an empty string for "the machine opened it".
      const failure = await shell.openPath(full);
      if (failure !== '') throw new Error(failure);
      return { file: full };
    }),
  );

  ipcMain.handle(CHANNELS.revealFile, (_event, request: unknown) =>
    attempt(async () => {
      const { full } = await insideRepository(request);
      // Shows the file in the machine's file manager, selected. Nothing to wait for and nothing to
      // report: the window it opens is the machine's, not ours.
      shell.showItemInFolder(full);
      return { file: full };
    }),
  );

  ipcMain.handle(CHANNELS.compare, (_event, request: unknown) =>
    attempt(async () => {
      const parsed = compareRequestSchema.parse(request);
      const repo = await openRepo(parsed.path);
      const comparison = await readComparison(repo, {
        left: parsed.left,
        right: parsed.right,
        ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
      });
      // The two lists and not the marked records: the window shows a list per side, and `records` is
      // the same data in git's order for a caller that wants it — the CLI's `--json` has both.
      return {
        root: repo.root,
        left: comparison.left,
        right: comparison.right,
        onlyLeft: comparison.onlyLeft,
        onlyRight: comparison.onlyRight,
      };
    }),
  );

  ipcMain.handle(CHANNELS.blame, (_event, request: unknown) =>
    attempt(async () => {
      const parsed = blameRequestSchema.parse(request);
      const repo = await openRepo(parsed.path);
      const lines = await readBlame(repo, {
        path: parsed.file,
        ...(parsed.rev === undefined ? {} : { rev: parsed.rev }),
      });
      return { root: repo.root, file: parsed.file, lines };
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

  ipcMain.handle(CHANNELS.remotes, (_event, path: unknown) =>
    attempt(async () => {
      const repo = await openRepo(statusPathSchema.parse(path));
      // The name and the two URLs, and not the raw lines: the panel shows what each remote points at,
      // and the CLI is where every line git printed is available.
      const remotes = (await readRemotes(repo)).map((remote) => ({
        name: remote.name,
        fetchUrl: remote.fetchUrl,
        pushUrl: remote.pushUrl,
      }));
      return { root: repo.root, remotes };
    }),
  );

  ipcMain.handle(CHANNELS.identity, (_event, path: unknown) =>
    attempt(async () => {
      const repo = await openRepo(statusPathSchema.parse(path));
      // The three in force, and not the whole record list: the window shows a card, and the CLI is
      // where every `user.*` entry is available.
      const { name, email, signingKey } = await readIdentity(repo);
      return { root: repo.root, identity: { name, email, signingKey } };
    }),
  );

  ipcMain.handle(CHANNELS.worktrees, (_event, path: unknown) =>
    attempt(async () => {
      const repo = await openRepo(String(path));
      return { root: repo.root, worktrees: await readWorktrees(repo) };
    }),
  );

  ipcMain.handle(CHANNELS.stashPatch, (_event, request: unknown) =>
    attempt(async () => {
      const parsed = stashPatchRequestSchema.parse(request);
      const repo = await openRepo(parsed.path);
      return { root: repo.root, files: await readStashPatch(repo, { selector: parsed.selector }) };
    }),
  );

  ipcMain.handle(CHANNELS.run, (event, request: unknown) =>
    attempt(async () => {
      // Parse, do not cast: this is the boundary between a web page and a process that
      // can delete a working tree.
      const parsed = runRequestSchema.parse(request);
      const repo = await openRepo(parsed.path);
      const result = await execute(parsed.command, {
        cwd: repo.root,
        // Sent as it arrives, so a window can say a fetch is moving rather than only that it
        // finished. The channel carries git's own line, parsed: the renderer decides how to draw it.
        onProgress: (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.runProgress, progress);
        },
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
      // A failed command that failed for a network reason carries the next step with it, because
      // git's stderr is a sentence for somebody who already knows how ssh and tokens work.
      const diagnosis = result.exitCode === 0 ? null : diagnoseFailure(result.stderr);
      return {
        op: parsed.command.op,
        risk: riskOf(parsed.command),
        argv: result.argv,
        diagnosis:
          diagnosis === null
            ? null
            : { failure: diagnosis.kind, what: diagnosis.what, whatToDo: diagnosis.whatToDo },
        reverse:
          reverse === null
            ? null
            : {
                command: reverse,
                // Redacted like every other argv a screen shows: the reverse of adding a remote
                // carries its URL, and a URL can hold a token.
                argv: toArgv(reverse).map(redact),
                risk: riskOf(reverse),
              },
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
