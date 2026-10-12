import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_QUICK_COMMANDS,
  type GraphData,
  type QuickCommand,
  type RepoState,
  type StashPayload,
} from '../shared/api.ts';
import { CommitPanel } from './CommitPanel.tsx';
import { GraphPane } from './GraphPane.tsx';
import { type ScreenState, StateScreen } from './StateScreen.tsx';
import { type Pending, summarize } from './shared.ts';
import { WorkingTreePanel } from './WorkingTreePanel.tsx';

/**
 * One open repository, with everything that belongs to it.
 *
 * A tab is not a path: it is the path plus the history that was read, the ref it is filtered
 * to, the window that was asked for, and the commit selected in it. Two tabs showing the
 * same repository are two different readings of it, which is exactly what two windows
 * would be.
 */
interface Tab {
  readonly id: number;
  /** What was typed or opened, before it resolved to a root. */
  readonly path: string;
  readonly root: string | null;
  readonly graph: GraphData | null;
  readonly status: RepoState | null;
  readonly stashes: readonly StashPayload['stashes'][number][];
  readonly selected: string | null;
  /** `*` reads every ref; anything else names the history to read instead. */
  readonly filter: string;
  /** The window, in commits. `Load more` raises it by `GRAPH_LIMIT` and reads again. */
  readonly limit: number;
}

const EMPTY_TAB = (id: number): Tab => ({
  id,
  path: '',
  root: null,
  graph: null,
  status: null,
  stashes: [],
  selected: null,
  filter: '*',
  limit: GRAPH_LIMIT,
});

/**
 * The graph is read one window at a time: a 200,000-commit repository must not cross IPC
 * as a single object. The window is only honest because the header says "300 of 2053",
 * so a reader can tell a truncated list from the whole history.
 */
const GRAPH_LIMIT = 300;

const MAX_TABS = 8;

export function App(): React.ReactElement {
  const [tabs, setTabs] = useState<readonly Tab[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const nextId = useRef(1);
  const [recents, setRecents] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<readonly string[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  // The confirmation sheet takes focus when it opens. Done with a ref rather than the
  // `autoFocus` attribute, which steals focus from a screen reader's reading position.
  const reasonInput = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (pending !== null) reasonInput.current?.focus();
  }, [pending]);

  const active = tabs.find((tab) => tab.id === activeId) ?? null;

  /**
   * Patching a tab by its id rather than by "whichever is active".
   *
   * `setActiveId` and `setTabs` do not land together, so a callback that closes over
   * `activeId` would patch the tab that was active before the new one was opened. The id is
   * passed in, and the opening sequence below owns it.
   */
  const patchTab = useCallback((id: number, patch: Partial<Omit<Tab, 'id'>>): void => {
    setTabs((previous) => previous.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)));
  }, []);

  /**
   * Opens a repository into a new tab, and makes it the active one. The id is allocated
   * here and returned, because the read that follows has to know which tab it is filling.
   */
  const openTab = useCallback(
    (path: string): number | null => {
      if (tabs.length >= MAX_TABS) {
        setError(`${MAX_TABS} repositories are open. Close one first.`);
        return null;
      }
      const id = nextId.current;
      nextId.current += 1;
      // Allocated out here, not inside the updater: an updater that also advances a counter
      // runs twice under StrictMode, and the caller would then fill a different tab from the
      // one it opened.
      setTabs((previous) => [...previous, EMPTY_TAB(id)]);
      setActiveId(id);
      setBusy(true);
      setError(null);
      // Remembered here and nowhere else: what a person asked for is what they asked for, a
      // typo included. Writing it again from the read that follows would race the next open.
      void window.orbitree.remember(path);
      patchTab(id, { path, graph: null, status: null, selected: null });
      return id;
    },
    [patchTab, tabs.length],
  );

  /**
   * Reads one repository: the status first and alone, then the graph the status allows.
   * Returns the graph, so the caller can put the reader at the top of a history it has not
   * read yet.
   */
  const refresh = useCallback(
    async (
      target: string,
      id: number,
      selection: string,
      requested: number,
    ): Promise<GraphData | null> => {
      setBusy(true);
      setError(null);
      const statusResult = await window.orbitree.status(target);
      if (!statusResult.ok) {
        setError(statusResult.error);
        patchTab(id, { graph: null, status: null });
        setBusy(false);
        return null;
      }
      const state = statusResult.value.state;
      patchTab(id, { status: state, path: statusResult.value.root, root: statusResult.value.root });

      const stashResult = await window.orbitree.readStash(target);
      patchTab(id, { stashes: stashResult.ok ? stashResult.value.stashes : [] });

      // An unborn head cannot be logged: `git log` exits 128 on a branch with no commits, so
      // the graph is not read at all rather than read and failed.
      if (state.head.kind === 'unborn') {
        patchTab(id, { graph: null });
        setBusy(false);
        return null;
      }

      const graphResult = await window.orbitree.graph(
        target,
        selection === '*' ? { limit: requested, all: true } : { limit: requested, rev: selection },
      );
      if (!graphResult.ok) {
        setError(graphResult.error);
        patchTab(id, { graph: null });
        setBusy(false);
        return null;
      }
      patchTab(id, {
        graph: graphResult.value.data,
        path: graphResult.value.root,
        root: graphResult.value.root,
      });
      setBusy(false);
      return graphResult.value.data;
    },
    [patchTab],
  );

  const openPath = useCallback(
    (path: string): void => {
      if (path === '') return;
      const id = openTab(path);
      if (id === null) return;
      void refresh(path, id, '*', GRAPH_LIMIT);
    },
    [openTab, refresh],
  );

  // What the app reopens on launch: the repository it was last in, unless a launch argument
  // names one, which is how the E2E suite points at a repository and how a file manager
  // would open one.
  //
  // Mount-only on purpose. It opens by id directly rather than through `openPath`, because that
  // callback's identity changes every time a tab is opened, and an effect depending on it would
  // re-run and open the same repository a second time on the next tab.
  useEffect(() => {
    const fromArgv = new URLSearchParams(window.location.search).get('repo');
    if (fromArgv !== null) {
      const id = nextId.current;
      nextId.current += 1;
      setTabs([EMPTY_TAB(id)]);
      setActiveId(id);
      // A repository named on the command line is still the repository being opened: what
      // you launch into is what you are in, so the quick window and the recents see it too.
      void window.orbitree.remember(fromArgv);
      void refresh(fromArgv, id, '*', GRAPH_LIMIT);
      return;
    }
    void (async () => {
      const state = await window.orbitree.readState();
      if (!state.ok) return;
      setRecents(state.value.recents);
      const last = state.value.last;
      if (last === null) return;
      const id = nextId.current;
      nextId.current += 1;
      setTabs([EMPTY_TAB(id)]);
      setActiveId(id);
      void window.orbitree.remember(last);
      void refresh(last, id, '*', GRAPH_LIMIT);
    })();
  }, [refresh]);

  /**
   * The dialog belongs to the main process, so the button asks for a path and opens whatever
   * comes back. Cancelling is not an error and not a state change.
   */
  const pick = useCallback(async (): Promise<void> => {
    const chosen = await window.orbitree.pickDirectory();
    if (chosen !== null) openPath(chosen);
  }, [openPath]);

  const closeTab = useCallback(
    (id: number): void => {
      const remaining = tabs.filter((tab) => tab.id !== id);
      setTabs(remaining);
      // Closing the active tab moves to the one beside it: the last one, then the first.
      if (id === activeId) setActiveId(remaining[remaining.length - 1]?.id ?? null);
    },
    [activeId, tabs],
  );

  const runCommand = useCallback(
    async (command: QuickCommand, reason?: string): Promise<boolean> => {
      if (active === null || active.root === null) return false;
      const target = active.root;
      const selection = active.filter;
      const requested = active.limit;
      setBusy(true);
      const result = await window.orbitree.run({
        path: target,
        command: command.command,
        ...(reason === undefined ? {} : { confirm: reason }),
      });
      setBusy(false);
      setPending(null);
      if (!result.ok) {
        setError(result.error);
        return false;
      }
      setLog((previous) => [summarize(result.value), ...previous].slice(0, 8));
      await refresh(target, active.id, selection, requested);
      return true;
    },
    [active, refresh],
  );

  const changeFilter = useCallback(
    async (selection: string): Promise<void> => {
      if (active === null || active.root === null) return;
      const target = active.root;
      patchTab(active.id, { filter: selection, limit: GRAPH_LIMIT, selected: null });
      const data = await refresh(target, active.id, selection, GRAPH_LIMIT);
      patchTab(active.id, { selected: data?.commits[0]?.hash ?? null });
    },
    [active, patchTab, refresh],
  );

  const loadMore = useCallback((): void => {
    if (active === null || active.root === null) return;
    const target = active.root;
    const next = active.limit + GRAPH_LIMIT;
    patchTab(active.id, { limit: next });
    // The selected hash is untouched: the larger window still contains it.
    void refresh(target, active.id, active.filter, next);
  }, [active, patchTab, refresh]);

  const screen: { state: ScreenState; detail: string | undefined } | null =
    active?.status == null
      ? null
      : active.status.pending !== null
        ? { state: active.status.pending, detail: undefined }
        : active.status.head.kind === 'unborn'
          ? { state: 'unborn', detail: active.status.head.name ?? undefined }
          : active.status.head.kind === 'detached'
            ? { state: 'detached', detail: active.status.head.oid.slice(0, 7) }
            : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          orbitree
        </div>
        <input
          className="path"
          value={active?.path ?? ''}
          placeholder="/path/to/a/repository"
          onChange={(event) => {
            if (active !== null) patchTab(active.id, { path: event.target.value });
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (active?.path ?? '') !== '') {
              openPath(active?.path ?? '');
            }
          }}
        />
        <button
          type="button"
          onClick={() => void pick()}
          disabled={busy}
          title="Choose a repository directory"
        >
          Browse
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => void openPath(active?.path ?? '')}
          disabled={(active?.path ?? '') === '' || busy}
        >
          Open
        </button>
      </header>

      {tabs.length > 0 && (
        <div className="tabbar" data-testid="tabbar">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={tab.id === activeId ? 'tab active' : 'tab'}
              data-testid="tab"
              data-tab-id={String(tab.id)}
              onClick={() => setActiveId(tab.id)}
            >
              <span className="tab-name">{tab.root === null ? tab.path : nameOf(tab.root)}</span>
              <button
                type="button"
                className="tab-close"
                aria-label={`close ${nameOf(tab.root ?? tab.path)}`}
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.id);
                }}
              >
                ×
              </button>
            </button>
          ))}
          <button
            type="button"
            className="tab new"
            data-testid="tab-new"
            onClick={() => {
              if (tabs.length < MAX_TABS) {
                const id = nextId.current;
                nextId.current += 1;
                setTabs((previous) => [...previous, EMPTY_TAB(id)]);
                setActiveId(id);
              }
            }}
          >
            +
          </button>
        </div>
      )}

      {active !== null && (
        <div className="quickbar">
          {DEFAULT_QUICK_COMMANDS.map((command) => (
            <button
              key={command.id}
              type="button"
              title={command.hint}
              className={command.danger ? 'quick danger' : 'quick'}
              disabled={busy}
              onClick={() => {
                if (command.danger) setPending({ command, reason: '' });
                else void runCommand(command);
              }}
            >
              {command.label}
            </button>
          ))}
          <span className="spacer" />
          <button
            type="button"
            className="quick"
            onClick={() => void refresh(active.root ?? '', active.id, active.filter, active.limit)}
            disabled={busy}
          >
            Refresh
          </button>
        </div>
      )}

      {error !== null && (
        <div className="error" role="alert">
          {error}
          <button type="button" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}

      <main className="panes">
        <section className="graph-pane">
          {active === null ? (
            <div className="empty" data-testid="no-tab">
              <p>No repository is open.</p>
              {recents.length > 0 && (
                <ul className="recents" data-testid="recents">
                  {recents.map((path) => (
                    <li key={path}>
                      <button
                        type="button"
                        data-testid="recent-item"
                        onClick={() => openPath(path)}
                      >
                        {nameOf(path)} <span className="recent-path">{path}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <>
              {screen === null ? null : screen.state === 'unborn' ? (
                <StateScreen state="unborn" detail={screen.detail} />
              ) : (
                <StateScreen state={screen.state} detail={screen.detail} variant="banner" />
              )}
              {active.graph === null ? (
                <p className="empty">
                  {screen?.state === 'unborn'
                    ? 'There is no history to draw yet.'
                    : 'Open a repository to see its graph.'}
                </p>
              ) : (
                <GraphPane
                  graph={active.graph}
                  selected={active.selected}
                  onSelect={(hash) => patchTab(active.id, { selected: hash })}
                  filter={active.filter}
                  onFilterChange={(value) => void changeFilter(value)}
                  pageSize={GRAPH_LIMIT}
                  onLoadMore={loadMore}
                />
              )}
            </>
          )}
        </section>

        <aside className="side">
          <CommitPanel root={active?.root ?? null} hash={active?.selected ?? null} />

          <WorkingTreePanel
            root={active?.root ?? null}
            state={active?.status ?? null}
            busy={busy}
            onStage={(entryPath) =>
              void runCommand({
                id: 'stage',
                label: 'Stage',
                hint: '',
                danger: false,
                command: { op: 'add', paths: [entryPath] },
              })
            }
            onUnstage={(entryPath) =>
              void runCommand({
                id: 'unstage',
                label: 'Unstage',
                hint: '',
                danger: false,
                command: { op: 'unstage', paths: [entryPath] },
              })
            }
            onCommit={(message, amend) =>
              runCommand({
                id: 'commit',
                label: 'Commit',
                hint: '',
                danger: false,
                command: { op: 'commit', message, ...(amend ? { amend: true } : {}) },
              })
            }
          />

          <div className="card">
            <h2>Stashes</h2>
            {active !== null && active.stashes.length === 0 ? (
              <p className="empty">no stash in this repository</p>
            ) : (
              <ul className="stash-list" data-testid="stash-list">
                {(active?.stashes ?? []).map((entry) => (
                  <li
                    key={`${active?.id ?? 0}:${entry.selector}`}
                    className="stash-entry"
                    data-testid="stash-entry"
                    data-selector={entry.selector}
                  >
                    <span className="selector">{entry.selector}</span>
                    <span className="subject">{entry.subject}</span>
                    <span className="stash-date">
                      {new Date(entry.committedAt * 1000).toISOString().slice(0, 16)} UTC
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="empty">read-only: applying or dropping a stash is a P2 action</p>
          </div>

          <div className="card">
            <h2>Activity</h2>
            {log.length === 0 ? (
              <p className="empty">nothing run yet</p>
            ) : (
              <pre>{log.join('\n')}</pre>
            )}
          </div>
        </aside>
      </main>

      {pending !== null && (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true">
            <h2>{pending.command.label}</h2>
            <p>
              This is a destructive command: <code>{pending.command.hint}</code>. Say why, so the
              reason is on the record.
            </p>
            <input
              ref={reasonInput}
              value={pending.reason}
              onChange={(event) => setPending({ ...pending, reason: event.target.value })}
              placeholder="reason"
            />
            <div className="modal-actions">
              <button type="button" onClick={() => setPending(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="danger"
                disabled={pending.reason.trim() === ''}
                onClick={() => void runCommand(pending.command, pending.reason)}
              >
                Run it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** The last path segment, so a tab is a name and not a full path. */
function nameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}
