import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type DiffFile,
  type GitCommand,
  type Commit,
  type GraphData,
  type IdentityPayload,
  type Progress,
  type RemotesPayload,
  type QuickCommand,
  type RepoState,
  type StashPayload,
} from '../shared/api.ts';
import { CommitPanel } from './CommitPanel.tsx';
import { DiffView } from './DiffView.tsx';
import { type CommitAction, GraphPane } from './GraphPane.tsx';
import { LeftPanel } from './LeftPanel.tsx';
import { ActivityIcon, BranchIcon, CloseIcon, CopyIcon, quickIcon, StashIcon } from './icons.tsx';
import { type ScreenState, StateScreen } from './StateScreen.tsx';
import { quickCommands } from './commands.ts';
import { Palette } from './Palette.tsx';
import { describeProgress, type Pending, type RunRecord, recordRun } from './shared.ts';
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
  /** The names this tab is not drawing. Per tab, because two readings are two pictures. */
  readonly hidden: readonly string[];
  /** The other working directories of this repository, read with everything else. */
  /** Who commits will be authored as, read with everything else. */
  readonly identity: IdentityPayload['identity'] | null;
  /**
   * What the graph is being searched for, or `{}`.
   *
   * A filter of the *picture*, like `hidden` and `filter`: nothing is written, and the read asks git for
   * a narrower history rather than filtering a list the window already has — because the window holds a
   * page of it, and searching a page is not searching the repository.
   */
  readonly search: {
    readonly grep?: string;
    readonly author?: string;
    readonly since?: string;
    readonly until?: string;
  };
  /** The remotes the config holds: a name and the two URLs it points at. */
  readonly remotes: RemotesPayload['remotes'];
  readonly worktrees: readonly {
    readonly path: string;
    readonly branch: string | null;
    readonly bare: boolean;
    readonly detached: boolean;
    readonly locked: string | null;
    readonly prunable: string | null;
  }[];
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
  hidden: [],
  worktrees: [],
  identity: null,
  search: {},
  remotes: [],
  gone: null,
});

/**
 * One side of a comparison: the commits only this side has, each a jump into the graph.
 *
 * A list rather than a picture, because the graph is the repository's and this is the difference
 * between two readings of it: what a reader wants is the commits, and where each of them sits in the
 * graph is one click away.
 */
function CompareList({
  side,
  name,
  commits,
  onSelectCommit,
}: {
  readonly side: 'left' | 'right';
  readonly name: string;
  readonly commits: readonly Commit[];
  readonly onSelectCommit: (oid: string) => void;
}): React.ReactElement {
  return (
    <ul className="compare-list" data-testid="compare-list" data-side={side}>
      {commits.length === 0 ? (
        <li className="empty" data-testid="compare-none">
          nothing
        </li>
      ) : (
        commits.map((commit) => (
          <li
            key={commit.hash}
            className="compare-row"
            data-testid="compare-row"
            data-hash={commit.hash}
          >
            <button
              type="button"
              className="compare-link"
              data-testid="compare-jump"
              title={`on ${name} only: ${commit.subject}`}
              onClick={() => onSelectCommit(commit.hash)}
            >
              <code className="compare-oid">{commit.hash.slice(0, 8)}</code>
              <span className="compare-subject">{commit.subject}</span>
              <span className="compare-author">{commit.author.name}</span>
            </button>
          </li>
        ))
      )}
    </ul>
  );
}

/**
 * The graph is read one window at a time: a 200,000-commit repository must not cross IPC
 * as a single object. The window is only honest because the header says "300 of 2053",
 * so a reader can tell a truncated list from the whole history.
 */
const GRAPH_LIMIT = 300;

const MAX_TABS = 8;

/** One value — or two, for a remote — that an action needs before it can run. */
interface AskState {
  /**
   * What the values are for. `rename` carries the branch being renamed in `hash`, which is the field
   * the other kinds use for the commit their name will point at or for the remote they act on: one
   * dialog, six questions.
   */
  readonly kind: 'branch' | 'tag' | 'rename' | 'remote-add' | 'remote-rename' | 'remote-url';
  readonly hash: string;
  readonly value: string;
  /** The second value, which only `remote-add` has: a name and where it points. */
  readonly value2: string;
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
  if (ask.kind === 'remote-add') return 'Add a remote';
  if (ask.kind === 'remote-rename') return `Rename ${ask.hash}`;
  if (ask.kind === 'remote-url') return `Where ${ask.hash} points`;
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
  /**
   * The progress of the command that is running, or of the last one that reported any.
   *
   * Kept after the command ends rather than cleared: a fetch that finished is a fetch that moved,
   * and the line saying how far it got is the same line a person was watching. It is cleared when
   * the next command starts, which is when it stops being about anything that just happened.
   */
  const [progress, setProgress] = useState<Progress | null>(null);
  /**
   * A comparison somebody asked for from the panel, or `null`.
   *
   * Not per tab and not stored: it is an answer to a question that was asked about the branch that was
   * checked out at that moment, and a refreshed or switched branch makes it a statement about the past.
   * Clicking the same button again asks again.
   */
  /** The command palette: open, or not. It reads the registry, so it lists what applies right now. */
  const [palette, setPalette] = useState(false);
  const [comparison, setComparison] = useState<{
    readonly left: string;
    readonly onlyLeft: readonly Commit[];
    readonly right: string;
    readonly onlyRight: readonly Commit[];
  } | null>(null);
  /** Bumped by every operation that ran, so a pane holding a diff knows to read it again. */
  const [revision, setRevision] = useState(0);
  /** The working tree's own card, so the WIP node can point at it without searching the document. */
  const workingTreeCard = useRef<HTMLDivElement | null>(null);
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
  // Progress arrives as it happens, from the process that runs git: an event rather than a field of
  // the result, because the result arrives when there is nothing left to report.
  useEffect(() => {
    window.orbitree.onRunProgress(setProgress);
  }, []);

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
      hidden: readonly string[] = [],
      search: Tab['search'] = {},
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

      // The worktrees of this repository: the same history in other directories, which is what a
      // second line of work is doing. Read with everything else rather than on demand, because the
      // panel shows them beside the branches and a section that loads when you look at it is a
      // section that moves under the cursor.
      const worktreeResult = await window.orbitree.readWorktrees(target);
      patchTab(id, { worktrees: worktreeResult.ok ? worktreeResult.value.worktrees : [] });

      // Who commits will be authored as, read with everything else: a name is configuration like the
      // remotes are, and a card that loaded when you looked at it would move under the cursor.
      const identityResult = await window.orbitree.readIdentity(target);
      patchTab(id, { identity: identityResult.ok ? identityResult.value.identity : null });

      // The remotes the config holds. A remote with nothing fetched from it has no rows in the
      // remote-branch list and is still a remote, which is why this is its own read.
      const remoteResult = await window.orbitree.readRemotes(target);
      patchTab(id, { remotes: remoteResult.ok ? remoteResult.value.remotes : [] });

      // An unborn head cannot be logged: `git log` exits 128 on a branch with no commits, so
      // the graph is not read at all rather than read and failed.
      if (state.head.kind === 'unborn') {
        patchTab(id, { graph: null });
        setBusy(false);
        return null;
      }

      const graphResult = await window.orbitree.graph(target, {
        limit: requested,
        ...(selection === '*' ? { all: true } : { rev: selection }),
        ...(hidden.length === 0 ? {} : { hide: hidden }),
        ...search,
      });
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

  /** A tab with nothing in it yet, which is what `+` has always been: the header browses from there. */
  const openEmptyTab = useCallback((): void => {
    if (tabs.length >= MAX_TABS) return;
    const id = nextId.current;
    nextId.current += 1;
    setTabs((previous) => [...previous, EMPTY_TAB(id)]);
    setActiveId(id);
  }, [tabs.length]);

  /**
   * The tab shortcuts, on one modifier: `Cmd` on macOS and `Ctrl` elsewhere, whichever the platform
   * uses, and never both.
   *
   * `1`–`8` are the tabs in order and `9` is the last one, which is the convention every browser and
   * editor trained a reader to expect, and the reason a ninth tab needs no tenth shortcut. They work
   * while typing as well: a commit message is not a place where `Cmd+1` means the digit.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key >= '1' && key <= '9') {
        const index = key === '9' ? tabs.length - 1 : Number(key) - 1;
        const tab = tabs[index];
        if (tab === undefined) return;
        event.preventDefault();
        setActiveId(tab.id);
        return;
      }
      if (key === 't') {
        event.preventDefault();
        openEmptyTab();
        return;
      }
      if (key === 'w' && activeId !== null) {
        event.preventDefault();
        closeTab(activeId);
        return;
      }
      // The palette, on the key most editors trained a reader to try. It is a toggle: the same press
      // that opens it closes it, which is what Escape does too.
      if (key === 'k') {
        event.preventDefault();
        setPalette((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tabs, activeId, closeTab, openEmptyTab]);

  /** Asks git what each side has, and shows it. The read is cheap; the answer is a card. */
  const compareWith = useCallback(
    async (ref: string): Promise<void> => {
      if (active === null || active.root === null) return;
      const head = active.status?.head;
      const mine = head?.kind === 'branch' ? head.name : 'HEAD';
      setBusy(true);
      const result = await window.orbitree.compare({
        path: active.root,
        left: mine,
        right: ref,
      });
      setBusy(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setComparison({
        left: result.value.left,
        onlyLeft: result.value.onlyLeft,
        right: result.value.right,
        onlyRight: result.value.onlyRight,
      });
    },
    [active],
  );

  const runCommand = useCallback(
    async (command: QuickCommand, reason?: string): Promise<boolean> => {
      if (active === null || active.root === null) return false;
      const target = active.root;
      const selection = active.filter;
      const requested = active.limit;
      const { hidden: hiddenNames, search: activeSearch } = active;
      setBusy(true);
      setProgress(null);
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
      await refresh(target, active.id, selection, requested, hiddenNames, activeSearch);
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
          setAsk({ kind: 'branch', hash: commit.hash, value: '', value2: '' });
          return;
        case 'create-tag':
          setAsk({ kind: 'tag', hash: commit.hash, value: '', value2: '' });
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
    const second = ask.value2.trim();
    // A remote needs both halves: a name with nowhere to point is not a remote, and a URL with no
    // name cannot be asked for anything.
    if (name === '' || (ask.kind === 'remote-add' && second === '')) return;
    const command: GitCommand =
      ask.kind === 'branch'
        ? { op: 'branch-create', name, start: ask.hash }
        : ask.kind === 'rename'
          ? { op: 'branch-rename', name: ask.hash, to: name }
          : ask.kind === 'remote-add'
            ? { op: 'remote-add', name, url: second }
            : ask.kind === 'remote-rename'
              ? { op: 'remote-rename', name: ask.hash, to: name }
              : ask.kind === 'remote-url'
                ? { op: 'remote-set-url', name: ask.hash, url: name }
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
            : ask.kind === 'remote-add'
              ? `remote add ${name} ${second}`
              : ask.kind === 'remote-rename'
                ? `remote rename ${ask.hash} ${name}`
                : ask.kind === 'remote-url'
                  ? `remote set-url ${ask.hash} ${name}`
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
      const data = await refresh(
        target,
        active.id,
        selection,
        GRAPH_LIMIT,
        active.hidden,
        active.search,
      );
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
    void refresh(target, active.id, active.filter, next, active.hidden, active.search);
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
              // A middle click closes, which is what the gesture means on every tab strip. The
              // `mousedown` is prevented so Chromium does not start its autoscroll on the way.
              onMouseDown={(event) => {
                if (event.button === 1) event.preventDefault();
              }}
              onAuxClick={(event) => {
                if (event.button !== 1) return;
                event.preventDefault();
                closeTab(tab.id);
              }}
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
          <button type="button" className="tab new" data-testid="tab-new" onClick={openEmptyTab}>
            +
          </button>
        </div>
      )}

      {active !== null && (
        <div className="quickbar">
          {quickCommands().map((command) => {
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
          {progress === null ? null : (
            <span className="progress" data-testid="run-progress" role="status">
              {describeProgress(progress)}
            </span>
          )}
          <button
            type="button"
            className="quick"
            onClick={() =>
              void refresh(
                active.root ?? '',
                active.id,
                active.filter,
                active.limit,
                active.hidden,
                active.search,
              )
            }
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
              worktrees={active?.worktrees ?? []}
              identity={active?.identity ?? null}
              remotes={active?.remotes ?? []}
              onAddRemote={() => setAsk({ kind: 'remote-add', hash: '', value: '', value2: '' })}
              onRenameRemote={(remote) =>
                setAsk({ kind: 'remote-rename', hash: remote, value: remote, value2: '' })
              }
              onSetRemoteUrl={(remote, url) =>
                setAsk({ kind: 'remote-url', hash: remote, value: url, value2: '' })
              }
              onRemoveRemote={(remote) =>
                runGuarded({
                  id: 'remote-remove',
                  label: `Remove ${remote}`,
                  hint: `remote remove ${remote}`,
                  danger: false,
                  command: { op: 'remote-remove', name: remote },
                })
              }
              openPaths={tabs
                .map((tab) => tab.root)
                .filter((root): root is string => root !== null)}
              onOpenWorktree={(path) => openPath(path)}
              filter={active?.filter ?? '*'}
              hidden={active?.hidden ?? []}
              busy={busy}
              onToggleHide={(ref) => {
                if (active === null) return;
                // The list, not the repository: nothing is written, and the same button brings the
                // name back — which is why the row stays where it is.
                const hidden = active.hidden.includes(ref.shortName)
                  ? active.hidden.filter((name) => name !== ref.shortName)
                  : [...active.hidden, ref.shortName];
                patchTab(active.id, { hidden });
                void refresh(
                  active.root ?? '',
                  active.id,
                  active.filter,
                  active.limit,
                  hidden,
                  active.search,
                );
              }}
              onFilter={(revision) => void changeFilter(revision)}
              onCompare={(ref) => void compareWith(ref.shortName)}
              search={active?.search ?? {}}
              onSearch={(form) => {
                if (active === null) return;
                // "Only mine" is the address in force, read from the identity card rather than typed a
                // second time: one place knows who is committing, and it is the one the panel shows.
                const email = active.identity?.email?.value;
                const author = form.mine === true ? email : form.author;
                // Empty fields are left out rather than sent as empty strings, which the core refuses
                // and which would mean "filter by nothing".
                const fields: Tab['search'] = {
                  ...(form.grep === undefined || form.grep === '' ? {} : { grep: form.grep }),
                  ...(author === undefined || author === '' ? {} : { author }),
                  ...(form.since === undefined || form.since === '' ? {} : { since: form.since }),
                  ...(form.until === undefined || form.until === '' ? {} : { until: form.until }),
                };
                patchTab(active.id, { search: fields });
                void refresh(
                  active.root ?? '',
                  active.id,
                  active.filter,
                  active.limit,
                  active.hidden,
                  fields,
                );
              }}
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
                setAsk({ kind: 'rename', hash: ref.shortName, value: ref.shortName, value2: '' })
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
                  searching={Object.keys(active.search).length > 0}
                  pageSize={GRAPH_LIMIT}
                  onLoadMore={loadMore}
                  onWipClick={() => {
                    // The card is already on screen, so this is the whole of it: bring it into view
                    // and put the keyboard there, because the node was clicked to get to it.
                    workingTreeCard.current?.scrollIntoView({ block: 'nearest' });
                    workingTreeCard.current?.focus();
                  }}
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
              cardRef={workingTreeCard}
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
              onOpenFile={(entryPath) => {
                void window.orbitree
                  .openFile({ path: active?.root ?? '', file: entryPath })
                  .then((result) => {
                    // The machine's own answer when it could not: a file git knows about and the disk
                    // does not is a state worth saying out loud rather than a button that does nothing.
                    if (!result.ok) setError(result.error);
                  });
              }}
              onRevealFile={(entryPath) => {
                void window.orbitree
                  .revealFile({ path: active?.root ?? '', file: entryPath })
                  .then((result) => {
                    if (!result.ok) setError(result.error);
                  });
              }}
              onSelectCommit={(oid) => {
                // The jump: the graph's selection is per tab, and the pane scrolls the selected row
                // into view, so naming the commit is the whole of it.
                if (active !== null) patchTab(active.id, { selected: oid });
              }}
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
              onSaveConflict={(entryPath, content) =>
                runGuarded({
                  id: 'resolve-file',
                  label: `Write ${entryPath}`,
                  hint: `apply --recount (the whole of ${entryPath})`,
                  // Nothing is destroyed that git cannot put back: the three stages are still in the
                  // index, and `checkout -m` puts the conflict there again — which is exactly the
                  // reverse the activity card will offer.
                  danger: false,
                  command: { op: 'resolve-file', path: entryPath, content },
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

            {comparison === null ? null : (
              <div className="card" data-testid="compare-card">
                <h2>
                  <BranchIcon size={13} />
                  Compare
                </h2>
                <p className="empty" data-testid="compare-summary">
                  only on <code>{comparison.left}</code> ({comparison.onlyLeft.length}) · only on{' '}
                  <code>{comparison.right}</code> ({comparison.onlyRight.length})
                </p>
                <CompareList
                  side="left"
                  name={comparison.left}
                  commits={comparison.onlyLeft}
                  onSelectCommit={(oid) => {
                    if (active !== null) patchTab(active.id, { selected: oid });
                  }}
                />
                <CompareList
                  side="right"
                  name={comparison.right}
                  commits={comparison.onlyRight}
                  onSelectCommit={(oid) => {
                    if (active !== null) patchTab(active.id, { selected: oid });
                  }}
                />
              </div>
            )}

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
                          <code>{`git ${run.reverse.argv.join(' ')}`}</code>
                          <button
                            type="button"
                            className={
                              run.reverse.risk === 'destructive' ? 'stage danger' : 'stage'
                            }
                            data-testid="activity-undo"
                            disabled={busy}
                            // The reverse of a destructive operation is one too, so it goes through
                            // the same sheet as anything else that changes something for good.
                            onClick={() =>
                              runGuarded({
                                id: 'undo',
                                label: `Undo \`${run.command}\``,
                                hint: `git ${run.reverse?.argv.join(' ') ?? ''}`,
                                danger: run.reverse?.risk === 'destructive',
                                command: run.reverse?.command ?? { op: 'status' },
                              })
                            }
                          >
                            undo
                          </button>
                          <button
                            type="button"
                            className="run-copy"
                            data-testid="activity-copy-reverse"
                            title="Copy the command that reverses this"
                            onClick={() => {
                              void navigator.clipboard.writeText(
                                `git ${run.reverse?.argv.join(' ') ?? ''}`,
                              );
                            }}
                          >
                            <CopyIcon size={12} />
                          </button>
                        </span>
                      )}
                      {run.detail === '' ? null : <span className="run-detail">{run.detail}</span>}
                      {run.advice === null ? null : (
                        <span className="run-advice" data-testid="activity-advice">
                          {run.advice}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        )}
      </main>

      {palette ? (
        <Palette
          context={{ selected: active?.selected ?? null }}
          {...(busy ? { busy } : {})}
          onClose={() => setPalette(false)}
          onRun={(entry) => {
            setPalette(false);
            // The same path a click takes, danger and all: a destructive command opens the sheet.
            runGuarded({
              id: entry.id,
              label: entry.label,
              hint: entry.hint,
              danger: entry.danger,
              command: entry.command,
            });
          }}
        />
      ) : null}

      {pending !== null && (
        <div className="modal-backdrop">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            // Escape closes the sheet, like every other modal here: a dialog that ignores it is a
            // dialog that traps, and the command it was asking about has not run.
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setPending(null);
              }
            }}
          >
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
                ask.kind === 'tag'
                  ? 'tag name'
                  : ask.kind === 'rename' || ask.kind === 'remote-rename'
                    ? 'new name'
                    : ask.kind === 'remote-add'
                      ? 'remote name'
                      : ask.kind === 'remote-url'
                        ? 'URL'
                        : 'branch name'
              }
            />
            {ask.kind === 'remote-add' ? (
              <input
                data-testid="ask-input-url"
                value={ask.value2}
                onChange={(event) => setAsk({ ...ask, value2: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    confirmAsk();
                  }
                }}
                placeholder="URL"
              />
            ) : null}
            <div className="modal-actions">
              <button type="button" onClick={() => setAsk(null)}>
                Cancel
              </button>
              <button
                type="button"
                data-testid="ask-confirm"
                className="primary"
                // A remote needs both halves, and a button that is enabled and does nothing is worse
                // than one that says why it cannot be pressed.
                disabled={
                  ask.value.trim() === '' || (ask.kind === 'remote-add' && ask.value2.trim() === '')
                }
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
