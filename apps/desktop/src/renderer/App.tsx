import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_QUICK_COMMANDS,
  type DiffFile,
  type GitCommand,
  type GraphData,
  type QuickCommand,
  type RepoState,
  type StashPayload,
} from '../shared/api.ts';
import { CommitPanel } from './CommitPanel.tsx';
import { DiffView } from './DiffView.tsx';
import { type CommitAction, GraphPane } from './GraphPane.tsx';
import { LeftPanel } from './LeftPanel.tsx';
import { ActivityIcon, CloseIcon, CopyIcon, quickIcon, StashIcon } from './icons.tsx';
import { type ScreenState, StateScreen } from './StateScreen.tsx';
import { type Pending, type RunRecord, recordRun } from './shared.ts';
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
  /** Set when the directory could not be read at all: a state screen, not a banner. */
  readonly gone: string | null;
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
  gone: null,
});

/**
 * The graph is read one window at a time: a 200,000-commit repository must not cross IPC
 * as a single object. The window is only honest because the header says "300 of 2053",
 * so a reader can tell a truncated list from the whole history.
 */
const GRAPH_LIMIT = 300;

const MAX_TABS = 8;

/** One value the commit menu needs before it can run: a branch or a tag name. */
interface AskState {
  /**
   * What the value is for. `rename` carries the branch being renamed in `hash`, which is the
   * field the other two use for the commit their name will point at: one dialog, three questions.
   */
  readonly kind: 'branch' | 'tag' | 'rename';
  readonly hash: string;
  readonly value: string;
}

/** One dialog, three questions, so its title is a function of the question. */
/**
 * What the repository looked like before an operation, as far as the window knows it.
 *
 * The window is not reading anything for this: the last status read carries HEAD, and the last refs
 * read carries what every branch and tag points at. That is also why the snapshot is taken from the
 * tab that owns the operation rather than from a fresh look at the repository: the state that
 * matters is the one the person was looking at.
 */
/** The submodules the working tree knows about, from the state it already read. */
function submodulesOf(tab: Tab | undefined): readonly {
  readonly path: string;
  readonly state: string;
}[] {
  return (tab?.status?.entries ?? [])
    .filter((entry) => entry.submodule !== null)
    .map((entry) => ({ path: entry.path, state: entry.submodule ?? '' }));
}

function beforeStateOf(tab: Tab): {
  readonly head: string | null;
  readonly branch: string | null;
  readonly targets: Readonly<Record<string, string>>;
} {
  const head = tab.status?.head;
  const targets: Record<string, string> = {};
  for (const ref of tab.graph?.refs ?? []) {
    if (ref.kind === 'branch' || ref.kind === 'tag') targets[ref.shortName] = ref.target;
  }
  return {
    head: head === undefined || head.kind === 'unborn' ? null : head.oid,
    branch: head?.kind === 'branch' ? head.name : null,
    targets,
  };
}

function askTitle(ask: AskState): string {
  if (ask.kind === 'branch') return 'Create branch here';
  if (ask.kind === 'tag') return 'Create tag here';
  return `Rename ${ask.hash}`;
}

export function App(): React.ReactElement {
  const [tabs, setTabs] = useState<readonly Tab[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const nextId = useRef(1);
  const [recents, setRecents] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<readonly RunRecord[]>([]);
  /** Bumped by every operation that ran, so a pane holding a diff knows to read it again. */
  const [revision, setRevision] = useState(0);
  /** The left panel's width. Resized by dragging, remembered for the session. */
  const [panelWidth, setPanelWidth] = useState(220);
  /** The one stash whose patch is on screen, or null. Read on demand: the list is cheap, the
   *  patches are not. */
  const [patch, setPatch] = useState<{
    readonly selector: string;
    readonly files: readonly DiffFile[];
  } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [ask, setAsk] = useState<AskState | null>(null);
  // The confirmation sheet takes focus when it opens. Done with a ref rather than the
  // `autoFocus` attribute, which steals focus from a screen reader's reading position.
  const reasonInput = useRef<HTMLInputElement | null>(null);
  const askInput = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (pending !== null) reasonInput.current?.focus();
  }, [pending]);
  useEffect(() => {
    if (ask !== null) askInput.current?.focus();
  }, [ask]);

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
        // A repository whose directory has gone is a place the app can describe, so it does: a
        // state screen instead of a banner, and no attempt to reopen it on the next launch. The
        // path stays in the recents list, because the directory may only be unmounted.
        const gone =
          statusResult.kind === 'PathNotFoundError' || statusResult.kind === 'NotARepositoryError';
        if (gone) {
          void window.orbitree.forgetLast(target);
          patchTab(id, { path: target, graph: null, status: null, gone: target, selected: null });
          setBusy(false);
          return null;
        }
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
        // What the repository looked like before, from what the window already has in memory: the
        // last status read for HEAD, the last refs read for what a branch or a tag pointed at. A
        // second read here would be a state that could have moved in between.
        before: beforeStateOf(active),
        ...(reason === undefined ? {} : { confirm: reason }),
      });
      setBusy(false);
      setPending(null);
      if (!result.ok) {
        setError(result.error);
        return false;
      }
      setRuns((previous) => [recordRun(result.value), ...previous].slice(0, 8));
      setRevision((previous) => previous + 1);
      await refresh(target, active.id, selection, requested);
      return true;
    },
    [active, refresh],
  );

  /**
   * A command that changes the repository, confirmed first when its risk says so.
   *
   * Both callers that take one — the quick bar and a file's own discard — go through here, so
   * "destructive means confirmed" has one implementation rather than two that agree today.
   */
  const runGuarded = useCallback(
    (command: QuickCommand): void => {
      if (command.danger) setPending({ command, reason: '' });
      else void runCommand(command);
    },
    [runCommand],
  );

  /**
   * Dragging the divider between the panel and the graph.
   *
   * Clamped on both sides: narrower than its own buttons is a panel nobody can use, and wider than
   * a third of the window is a panel that has quietly become the window.
   */
  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      event.preventDefault();
      const from = event.clientX;
      const starting = panelWidth;
      const move = (moved: PointerEvent): void => {
        setPanelWidth(Math.max(170, Math.min(420, starting + moved.clientX - from)));
      };
      const stop = (): void => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', stop);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', stop);
    },
    [panelWidth],
  );

  /** Looking at a stash before doing anything to it. Clicking it again puts the patch away. */
  const showStash = useCallback(
    async (selector: string): Promise<void> => {
      const root = active?.root ?? null;
      if (root === null) return;
      if (patch?.selector === selector) {
        setPatch(null);
        return;
      }
      const result = await window.orbitree.readStashPatch({ path: root, selector });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPatch({ selector, files: result.value.files });
    },
    [active, patch],
  );

  const onStash = useCallback(
    (kind: 'apply' | 'pop' | 'drop', selector: string): void => {
      setPatch(null);
      runGuarded({
        id: `stash-${kind}`,
        label: kind === 'apply' ? 'Apply stash' : kind === 'pop' ? 'Pop stash' : 'Drop stash',
        hint: `stash ${kind} ${selector}`,
        // Applying and popping put the work back in the working tree; dropping is the one that
        // throws it away without putting it anywhere.
        danger: kind === 'drop',
        command:
          kind === 'apply'
            ? { op: 'stash-apply', selector }
            : kind === 'pop'
              ? { op: 'stash-pop', selector }
              : { op: 'stash-drop', selector },
      });
    },
    [runGuarded],
  );

  /**
   * The commit menu's actions. Everything that mutates goes through `runCommand`, the path
   * the quick bar already uses, so there is still one place that reaches git.
   */
  const onCommitAction = useCallback(
    (action: CommitAction, commit: { readonly hash: string; readonly subject: string }): void => {
      switch (action) {
        case 'create-branch':
          setAsk({ kind: 'branch', hash: commit.hash, value: '' });
          return;
        case 'create-tag':
          setAsk({ kind: 'tag', hash: commit.hash, value: '' });
          return;
        case 'checkout':
          void runCommand({
            id: 'checkout',
            label: 'Check out this commit',
            hint: `switch --detach ${commit.hash.slice(0, 7)}`,
            danger: false,
            command: { op: 'checkout', ref: commit.hash, detach: true },
          });
          return;
        case 'reset-hard':
          setPending({
            command: {
              id: 'reset-hard',
              label: 'Reset --hard to here',
              hint: `reset --hard ${commit.hash.slice(0, 7)}`,
              danger: true,
              command: { op: 'reset-hard', rev: commit.hash },
            },
            reason: '',
          });
          return;
        case 'copy-sha':
          void navigator.clipboard.writeText(commit.hash);
          return;
        case 'copy-short-sha':
          void navigator.clipboard.writeText(commit.hash.slice(0, 7));
          return;
        case 'copy-message':
          void navigator.clipboard.writeText(commit.subject);
          return;
      }
    },
    [runCommand],
  );

  const confirmAsk = useCallback((): void => {
    if (ask === null) return;
    const name = ask.value.trim();
    if (name === '') return;
    const command: GitCommand =
      ask.kind === 'branch'
        ? { op: 'branch-create', name, start: ask.hash }
        : ask.kind === 'rename'
          ? { op: 'branch-rename', name: ask.hash, to: name }
          : { op: 'tag-create', name, rev: ask.hash };
    setAsk(null);
    void runCommand({
      id: ask.kind,
      label: askTitle(ask),
      hint:
        ask.kind === 'branch'
          ? `branch ${name}`
          : ask.kind === 'rename'
            ? `branch -m ${ask.hash} ${name}`
            : `tag ${name}`,
      danger: false,
      command,
    });
  }, [ask, runCommand]);

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
    active?.gone != null
      ? { state: 'gone', detail: active.gone }
      : active?.status == null
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
                <CloseIcon size={12} />
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
          {DEFAULT_QUICK_COMMANDS.map((command) => {
            const Glyph = quickIcon(command.id);
            return (
              <button
                key={command.id}
                type="button"
                title={command.hint}
                className={command.danger ? 'quick danger' : 'quick'}
                disabled={busy}
                onClick={() => runGuarded(command)}
              >
                {Glyph === null ? null : <Glyph />}
                <span>{command.label}</span>
              </button>
            );
          })}
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

      {/* Without a side pane there is nothing to put in the second column: a repository that is
          not there has one pane, and it takes the window. */}
      <main
        className={active?.gone != null ? 'panes single' : 'panes'}
        style={{ '--panel-width': `${panelWidth}px` } as React.CSSProperties}
      >
        {active?.gone != null ? null : (
          <>
            <LeftPanel
              refs={active?.graph?.refs ?? []}
              submodules={submodulesOf(active ?? undefined)}
              filter={active?.filter ?? '*'}
              busy={busy}
              onFilter={(revision) => void changeFilter(revision)}
              onSwitch={(ref) =>
                runGuarded({
                  id: 'checkout',
                  label: `Switch to ${ref.shortName}`,
                  hint: `switch ${ref.shortName}`,
                  danger: false,
                  command: { op: 'checkout', ref: ref.shortName },
                })
              }
              onMerge={(ref) =>
                runGuarded({
                  id: 'merge',
                  label: `Merge ${ref.shortName}`,
                  hint: `merge --no-edit ${ref.shortName}`,
                  // A merge that conflicts stops and leaves the repository mid-merge, which is a
                  // state the window has a screen for rather than a failure.
                  danger: false,
                  command: { op: 'merge', ref: ref.shortName },
                })
              }
              onRename={(ref) =>
                setAsk({ kind: 'rename', hash: ref.shortName, value: ref.shortName })
              }
              onDelete={(ref) =>
                runGuarded({
                  id: ref.kind === 'tag' ? 'tag-delete' : 'branch-delete',
                  label: `Delete ${ref.kind} ${ref.shortName}`,
                  hint:
                    ref.kind === 'tag' ? `tag -d ${ref.shortName}` : `branch -d ${ref.shortName}`,
                  // A tag deletion is destructive in the core — nothing refuses it — so the sheet
                  // asks for a reason. `git branch -d` refuses an unmerged branch itself.
                  danger: ref.kind === 'tag',
                  command:
                    ref.kind === 'tag'
                      ? { op: 'tag-delete', name: ref.shortName }
                      : { op: 'branch-delete', name: ref.shortName },
                })
              }
            />
            <div
              className="panel-resizer"
              data-testid="panel-resizer"
              title="Drag to resize"
              onPointerDown={startResize}
            />
          </>
        )}
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
                // A repository that has gone says so once, above; the placeholder is for the tab
                // that has nothing open at all.
                screen?.state === 'gone' ? null : (
                  <p className="empty">
                    {screen?.state === 'unborn'
                      ? 'There is no history to draw yet.'
                      : 'Open a repository to see its graph.'}
                  </p>
                )
              ) : (
                <GraphPane
                  graph={active.graph}
                  selected={active.selected}
                  onSelect={(hash) => patchTab(active.id, { selected: hash })}
                  filter={active.filter}
                  pageSize={GRAPH_LIMIT}
                  onLoadMore={loadMore}
                  onCommitAction={onCommitAction}
                />
              )}
            </>
          )}
        </section>

        {active?.gone != null ? null : (
          <aside className="side">
            <CommitPanel root={active?.root ?? null} hash={active?.selected ?? null} />

            <WorkingTreePanel
              root={active?.root ?? null}
              state={active?.status ?? null}
              busy={busy}
              revision={revision}
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
              onCommitAndPush={async (message, body, amend) => {
                const committed = await runCommand({
                  id: 'commit',
                  label: 'Commit',
                  hint: '',
                  danger: false,
                  command: {
                    op: 'commit',
                    message,
                    ...(body.trim() === '' ? {} : { body }),
                    ...(amend ? { amend: true } : {}),
                  },
                });
                // A commit that did not happen is not followed by a push: the second command would
                // then be pushing whatever was there before.
                if (!committed) return false;
                return runCommand({
                  id: 'push',
                  label: 'Push',
                  hint: 'push the current branch',
                  danger: false,
                  command: { op: 'push', remote: 'origin', branch: 'HEAD' },
                });
              }}
              onDiscard={(entryPath) => {
                // A path git has never tracked is removed by `clean`; a tracked one is restored.
                // `restore` on an untracked path is a no-op, which would look like a broken
                // button rather than a refusal.
                const untracked =
                  (active?.status?.entries ?? []).find((entry) => entry.path === entryPath)
                    ?.kind === 'untracked';
                runGuarded({
                  id: 'discard',
                  label: 'Discard',
                  hint: untracked
                    ? `clean -fd -- ${entryPath}`
                    : `restore --worktree -- ${entryPath}`,
                  danger: true,
                  command: untracked
                    ? { op: 'clean', paths: [entryPath] }
                    : { op: 'discard', paths: [entryPath] },
                });
              }}
              onTakeSide={(side, entryPath) =>
                runGuarded({
                  id: 'take-side',
                  label: `Take ${side}`,
                  hint: `checkout --${side} -- ${entryPath}`,
                  danger: false,
                  command: { op: 'take-side', side, paths: [entryPath] },
                })
              }
              onResolveRegion={(entryPath, region, take, content) =>
                runGuarded({
                  id: 'resolve-conflict',
                  label: `Resolve region ${region + 1} with ${take}`,
                  hint: `apply --recount (region ${region + 1} of ${entryPath})`,
                  danger: false,
                  command: {
                    op: 'resolve-conflict',
                    path: entryPath,
                    region,
                    take,
                    ...(content === undefined ? {} : { content }),
                  },
                })
              }
              onAbortMerge={() =>
                runGuarded({
                  id: 'merge-abort',
                  label: 'Abort the merge',
                  hint: 'merge --abort',
                  danger: false,
                  command: { op: 'merge-abort' },
                })
              }
              onDiscardHunk={(entryPath, hunk) =>
                runGuarded({
                  id: 'discard-hunk',
                  label: 'Discard hunk',
                  hint: `apply --reverse (hunk ${hunk + 1} of ${entryPath})`,
                  danger: true,
                  command: { op: 'discard-hunk', path: entryPath, hunk },
                })
              }
              onCommit={(message, body, amend) =>
                runCommand({
                  id: 'commit',
                  label: 'Commit',
                  hint: '',
                  danger: false,
                  command: {
                    op: 'commit',
                    message,
                    ...(body.trim() === '' ? {} : { body }),
                    ...(amend ? { amend: true } : {}),
                  },
                })
              }
            />

            <div className="card">
              <h2>
                <StashIcon size={13} />
                Stashes
              </h2>
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
                      <div className="stash-line">
                        <span className="selector">{entry.selector}</span>
                        <span className="subject">{entry.subject}</span>
                        <span className="stash-date">
                          {new Date(entry.committedAt * 1000).toISOString().slice(0, 16)} UTC
                        </span>
                        <button
                          type="button"
                          className="stage"
                          data-testid="stash-show"
                          disabled={busy}
                          onClick={() => void showStash(entry.selector)}
                        >
                          show
                        </button>
                        <button
                          type="button"
                          className="stage"
                          data-testid="stash-apply"
                          disabled={busy}
                          onClick={() => onStash('apply', entry.selector)}
                        >
                          apply
                        </button>
                        <button
                          type="button"
                          className="stage"
                          data-testid="stash-pop"
                          disabled={busy}
                          onClick={() => onStash('pop', entry.selector)}
                        >
                          pop
                        </button>
                        <button
                          type="button"
                          className="stage danger"
                          data-testid="stash-drop"
                          disabled={busy}
                          onClick={() => onStash('drop', entry.selector)}
                        >
                          drop
                        </button>
                      </div>
                      {patch?.selector === entry.selector ? (
                        <div className="stash-patch" data-testid="stash-patch">
                          {patch.files.map((file) => (
                            <DiffView key={file.path} file={file} />
                          ))}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              <p className="empty">
                apply and pop put the work back; drop destroys it, so it asks for a reason first
              </p>
            </div>

            <div className="card">
              <h2>
                <ActivityIcon size={13} />
                Activity
              </h2>
              {runs.length === 0 ? (
                <p className="empty">nothing run yet</p>
              ) : (
                <ul className="runs">
                  {runs.map((run) => (
                    <li key={run.id} className="run">
                      <code className="run-command" data-testid="activity-argv">
                        {run.command}
                      </code>
                      <span className={run.exitCode === 0 ? 'rc ok' : 'rc bad'}>
                        {run.exitCode}
                      </span>
                      <button
                        type="button"
                        className="run-copy"
                        data-testid="activity-copy"
                        data-command={run.command}
                        title="Copy this command"
                        onClick={() => {
                          void navigator.clipboard.writeText(run.command);
                        }}
                      >
                        <CopyIcon size={12} />
                      </button>
                      {run.reverse === null ? null : (
                        <span className="run-reverse" data-testid="activity-reverse">
                          <span className="run-reverse-label">undo with</span>
                          <code>{run.reverse}</code>
                          <button
                            type="button"
                            className="run-copy"
                            data-testid="activity-copy-reverse"
                            title="Copy the command that reverses this"
                            onClick={() => {
                              void navigator.clipboard.writeText(run.reverse ?? '');
                            }}
                          >
                            <CopyIcon size={12} />
                          </button>
                        </span>
                      )}
                      {run.detail === '' ? null : <span className="run-detail">{run.detail}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        )}
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

      {ask !== null && (
        <div className="modal-backdrop">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            data-testid="ask-dialog"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setAsk(null);
              }
            }}
          >
            <h2>{askTitle(ask)}</h2>
            <input
              ref={askInput}
              data-testid="ask-input"
              value={ask.value}
              onChange={(event) => setAsk({ ...ask, value: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  confirmAsk();
                }
              }}
              placeholder={
                ask.kind === 'tag' ? 'tag name' : ask.kind === 'rename' ? 'new name' : 'branch name'
              }
            />
            <div className="modal-actions">
              <button type="button" onClick={() => setAsk(null)}>
                Cancel
              </button>
              <button
                type="button"
                data-testid="ask-confirm"
                className="primary"
                disabled={ask.value.trim() === ''}
                onClick={confirmAsk}
              >
                Create
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
