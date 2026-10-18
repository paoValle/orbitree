import { useEffect, useState } from 'react';
import type {
  BlamePayload,
  DiffFile,
  GraphPayload,
  RepoState,
  StatusEntry,
} from '../shared/api.ts';
import { laneColor } from './GraphPane.tsx';
import { ConflictPanel } from './ConflictPanel.tsx';
import { DiffView } from './DiffView.tsx';
import { type FileKind, fileKind } from './fileKind.ts';
import {
  FileBinaryIcon,
  FileCodeIcon,
  FileConfigIcon,
  FileImageIcon,
  FileJsonIcon,
  FileMarkdownIcon,
  FileShellIcon,
  FileTextIcon,
  type IconProps,
  TreeIcon,
} from './icons.tsx';

/** One glyph per file family, so the working-tree column names the kind and not the letter. */
const KIND_ICON: Readonly<Record<FileKind, (props: IconProps) => React.ReactElement>> = {
  code: FileCodeIcon,
  shell: FileShellIcon,
  markdown: FileMarkdownIcon,
  text: FileTextIcon,
  json: FileJsonIcon,
  config: FileConfigIcon,
  image: FileImageIcon,
  binary: FileBinaryIcon,
  other: FileTextIcon,
};

/**
 * The working tree, split by the question each entry answers. A file can be staged and also
 * modified in the working tree; it appears in both sections because that is the truth, and
 * collapsing it into one row is how the two changes become indistinguishable.
 */
export type WorkingTreeSection = 'staged' | 'unstaged' | 'conflicted' | 'untracked';

export interface WorkingTreePanelProps {
  /** The card itself, so somebody else can bring it into view and put the keyboard on it. */
  readonly cardRef?: React.RefObject<HTMLDivElement | null>;
  readonly root: string | null;
  readonly state: RepoState | null;
  readonly busy?: boolean;
  /** The callbacks run the real operations through the app's one `run` path. */
  readonly onStage?: (path: string) => void;
  readonly onUnstage?: (path: string) => void;
  /**
   * Throws away what the working tree holds for one path.
   *
   * It is destructive and goes through the confirmation sheet like every other destructive
   * operation: what it removes is the only copy of that change.
   */
  readonly onDiscard?: (path: string) => void;
  /**
   * Throws away one hunk of one path.
   *
   * The patch is not built here: the executor reads the file's own diff and reverses the hunk it
   * names, so what crosses the channel is a path and an index rather than a web page's idea of
   * what the change is.
   */
  readonly onDiscardHunk?: (path: string, hunk: number) => void;
  /** Takes one side of a conflicted path into the working tree, leaving the conflict in the index. */
  readonly onTakeSide?: (side: 'ours' | 'theirs', path: string) => void;
  /** Gives up on the merge that is under way and puts the branch back where it was. */
  readonly onAbortMerge?: () => void;
  /** Writes one conflicted path out with the text an editor produced. */
  readonly onSaveConflict?: (path: string, content: string) => void;
  /**
   * Goes to a commit in the graph.
   *
   * The jump the blame pane exists for: a line's commit is only useful if a reader can see what else
   * that commit did, and the graph is where that is.
   */
  readonly onSelectCommit?: (oid: string) => void;
  /**
   * Opens one file with whatever the machine uses for it, or shows it in the file manager.
   *
   * The path is the repository's own: the window sends a path relative to the root and the process that
   * has the operating system's ear checks it stays inside.
   */
  readonly onOpenFile?: (path: string) => void;
  readonly onRevealFile?: (path: string) => void;
  /** Resolves one conflict region of one path, replacing it with a side or with typed text. */
  readonly onResolveRegion?: (
    path: string,
    region: number,
    take: 'ours' | 'theirs' | 'both' | 'custom',
    content?: string,
  ) => void;
  /**
   * Bumped by the app after every operation it ran, so the diff on screen is re-read.
   *
   * Without it the pane keeps the patch it loaded when the file was clicked: discarding a hunk
   * updates the file list and leaves the diff showing the hunk that is no longer there, which is
   * a picture of a moment that has passed and the most convincing kind of wrong.
   */
  readonly revision?: number;
  /**
   * `true` means the commit ran; the fields are only cleared when it did.
   *
   * Two arguments rather than one string, because a commit has two fields and git is what puts the
   * blank line between them: joining them here would be a second opinion about a commit's shape.
   */
  readonly onCommit?: (message: string, body: string, amend: boolean) => Promise<boolean>;
  /**
   * The commit and then the push, which is what a person does with a change they are finished with.
   *
   * Two commands rather than one the core invented: the activity card shows both, each with its own
   * reverse, and a commit that failed is not followed by a push — which would be pushing whatever
   * was there before.
   */
  readonly onCommitAndPush?: (message: string, body: string, amend: boolean) => Promise<boolean>;
}

interface SectionSpec {
  readonly section: WorkingTreeSection;
  readonly title: string;
}

const SECTIONS: readonly SectionSpec[] = [
  { section: 'staged', title: 'Staged' },
  { section: 'unstaged', title: 'Changes' },
  { section: 'conflicted', title: 'Conflicted' },
  { section: 'untracked', title: 'Untracked' },
];

function entriesFor(state: RepoState, section: WorkingTreeSection): readonly StatusEntry[] {
  switch (section) {
    // An unmerged entry is a conflict, not a staged change: it belongs in its own section
    // rather than being counted twice under statuses that are not what they seem.
    case 'staged':
      return state.entries.filter(
        (entry) =>
          (entry.kind === 'ordinary' || entry.kind === 'renamed') && entry.index !== 'unmodified',
      );
    case 'unstaged':
      return state.entries.filter(
        (entry) =>
          (entry.kind === 'ordinary' || entry.kind === 'renamed') &&
          entry.worktree !== 'unmodified',
      );
    case 'conflicted':
      return state.entries.filter((entry) => entry.kind === 'unmerged');
    case 'untracked':
      return state.entries.filter((entry) => entry.kind === 'untracked');
  }
}

/** How many commits of one file's history a pane reads. Well past what a file usually has. */
const HISTORY_LIMIT = 200;

/**
 * The commits that touched one file, in the graph's own shape.
 *
 * Rows rather than a canvas: the picture is the repository's, and this is one file's slice of it, so
 * what a reader needs is the list — with the lane each commit sits in, because that is the shape the
 * graph draws and the pane is showing the same reading of it.
 */
function HistoryView({
  path,
  loaded,
  onSelectCommit,
}: {
  readonly path: string;
  readonly loaded: {
    readonly data: GraphPayload['data'] | null;
    readonly error: string | null;
  } | null;
  readonly onSelectCommit?: (oid: string) => void;
}): React.ReactElement {
  if (loaded === null) return <p className="empty">loading…</p>;
  if (loaded.error !== null) return <p className="empty">{loaded.error}</p>;
  const commits = loaded.data?.commits ?? [];
  if (commits.length === 0) {
    // Not an error: nothing has touched this path yet.
    return <p className="empty">no commit has touched {path} yet</p>;
  }
  return (
    <ul className="history" data-testid="history">
      {commits.map((commit, index) => (
        <li
          key={commit.hash}
          className="history-row"
          data-testid="history-row"
          data-hash={commit.hash}
        >
          <button
            type="button"
            className="history-link"
            data-testid="history-jump"
            title={`${commit.subject} — show this commit in the graph`}
            onClick={() => onSelectCommit?.(commit.hash)}
          >
            <span
              className="history-lane"
              aria-hidden="true"
              style={{
                background: laneColor(loaded.data?.layout.rows[index]?.lane ?? 0),
              }}
            />
            <code className="history-oid">{commit.hash.slice(0, 8)}</code>
            <span className="history-subject">{commit.subject}</span>
            <span className="history-author">{commit.author.name}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The blame of one file, as a list a reader can jump from.
 *
 * A line that is only in the working tree has no commit behind it — git reports it against the
 * all-zero sha and calls its author `Not Committed Yet` — so it is rendered as a line with nowhere to
 * go rather than as a button that would select a commit that does not exist.
 */
function BlameView({
  path,
  loaded,
  onSelectCommit,
}: {
  readonly path: string;
  readonly loaded: {
    readonly lines: readonly BlamePayload['lines'][number][] | null;
    readonly error: string | null;
  } | null;
  readonly onSelectCommit?: (oid: string) => void;
}): React.ReactElement {
  if (loaded === null) return <p className="empty">loading…</p>;
  if (loaded.error !== null) return <p className="empty">{loaded.error}</p>;
  if (loaded.lines === null || loaded.lines.length === 0) {
    return <p className="empty">no lines in {path}</p>;
  }
  return (
    <ol className="blame" data-testid="blame">
      {loaded.lines.map((line) => {
        const committed = !/^0+$/.test(line.oid);
        const date = new Date(line.authorTime * 1000).toISOString().slice(0, 10);
        const head = committed ? (
          <>
            <code className="blame-oid">{line.oid.slice(0, 8)}</code>
            <span className="blame-author">{line.author}</span>
            <span className="blame-date">{date}</span>
          </>
        ) : (
          // git's own words for a line that is not in any commit, which is the honest thing to show:
          // the line exists, and no commit can be blamed for it yet.
          <span className="blame-author" data-testid="blame-not-committed">
            Not Committed Yet
          </span>
        );
        return (
          <li
            key={`${line.line}:${line.oid}`}
            className="blame-line"
            data-testid="blame-line"
            data-oid={line.oid}
          >
            {committed && onSelectCommit !== undefined ? (
              <button
                type="button"
                className="blame-link"
                data-testid="blame-jump"
                title={`${line.summary} — show this commit in the graph`}
                onClick={() => onSelectCommit(line.oid)}
              >
                {head}
              </button>
            ) : (
              <span className="blame-link">{head}</span>
            )}
            <code className="blame-content">{line.content}</code>
          </li>
        );
      })}
    </ol>
  );
}

export function WorkingTreePanel({
  cardRef,
  root,
  state,
  busy,
  onStage,
  onUnstage,
  onDiscard,
  onDiscardHunk,
  onTakeSide,
  onAbortMerge,
  onSaveConflict,
  onResolveRegion,
  revision,
  onCommit,
  onCommitAndPush,
  onSelectCommit,
  onOpenFile,
  onRevealFile,
}: WorkingTreePanelProps): React.ReactElement {
  const [message, setMessage] = useState('');
  const [body, setBody] = useState('');
  const [amend, setAmend] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [selected, setSelected] = useState<{
    readonly section: WorkingTreeSection;
    readonly path: string;
  } | null>(null);
  /**
   * The diff or the blame, for the file that is selected.
   *
   * A toggle rather than a second pane: the file is already on screen, and the two views are two
   * questions about the same file. It goes back to the diff when another file is clicked, because a
   * mode that follows you to the next file is a mode you forget you are in.
   */
  const [view, setView] = useState<'diff' | 'blame' | 'history'>('diff');
  const [blame, setBlame] = useState<{
    readonly key: string;
    readonly lines: readonly BlamePayload['lines'][number][] | null;
    readonly error: string | null;
  } | null>(null);
  /** The commits that touched the file, in the graph's own shape, read the same way. */
  const [history, setHistory] = useState<{
    readonly key: string;
    readonly data: GraphPayload['data'] | null;
    readonly error: string | null;
  } | null>(null);
  // The files are tagged with the selection they were read for. Without the tag, the previous
  // selection's whole-repo diff would be looked up by the new path before the new read lands,
  // and a staged click could show the working-tree version of the same file for a frame.
  const [loaded, setLoaded] = useState<{
    readonly key: string;
    readonly files: readonly DiffFile[] | null;
    readonly error: string | null;
  } | null>(null);

  const section = selected?.section ?? null;
  const path = selected?.path ?? null;
  const key = section === null || path === null ? null : `${section}:${path}`;

  // Read on demand, tagged with the key it was read for: the same shape as the diff above, for the
  // same reason — an answer that arrives after the reader has clicked another file must not be shown
  // as if it were about that one.
  useEffect(() => {
    // `revision` is a trigger rather than a value, exactly as in the diff effect below: an operation
    // that just ran changes what the blame of the working tree says.
    void revision;
    if (root === null || path === null || key === null) return;
    if (view !== 'blame') return;
    let cancelled = false;
    void window.orbitree.readBlame({ path: root, file: path }).then((result) => {
      if (cancelled) return;
      setBlame(
        result.ok
          ? { key, lines: result.value.lines, error: null }
          : { key, lines: null, error: result.error },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [root, path, key, view, revision]);

  // The file's history: the commits git says touched it, read through the same call the graph uses.
  // That is what "in the graph's own shape" means here — the same read, the same layout, a smaller
  // picture — rather than a second way of asking which commits mention a path.
  useEffect(() => {
    void revision;
    if (root === null || path === null || key === null) return;
    if (view !== 'history') return;
    let cancelled = false;
    void window.orbitree.graph(root, { limit: HISTORY_LIMIT, file: path }).then((result) => {
      if (cancelled) return;
      setHistory(
        result.ok
          ? { key, data: result.value.data, error: null }
          : { key, data: null, error: result.error },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [root, path, key, view, revision]);

  useEffect(() => {
    // `revision` is a trigger rather than a value: nothing here reads it, and the effect has to
    // run again when it changes. That is what re-reads a diff an operation just changed without
    // changing the selection, so the comment is the reference the rule is looking for.
    void revision;
    if (root === null || section === null || path === null) return;
    // An untracked file is in neither the index nor a commit, so there is no comparison to
    // load; the pane says so in words instead of asking git a question with no answer.
    if (section === 'untracked') return;
    let cancelled = false;
    // Staged is the index against HEAD; everything else is the working tree against the
    // index, which is the revision-less form. A conflicted file is the exception and is read
    // against HEAD too: git answers an unmerged path with a *combined* diff, which the patch
    // parser refuses outright, and against HEAD it is the plain two-tree diff whose `+` lines
    // are the conflict markers the reader came to see.
    const request =
      section === 'staged'
        ? { cached: true }
        : // An unmerged path is the one exception: git answers it with a *combined* diff, which
          // the patch parser refuses outright. Against HEAD it is the plain two-tree diff whose
          // `+` lines are the conflict markers the reader came to see.
          section === 'conflicted'
          ? { rev: 'HEAD' }
          : {};
    const requestKey = `${section}:${path}`;
    void window.orbitree.diff(root, request).then((result) => {
      if (cancelled) return;
      setLoaded(
        result.ok
          ? { key: requestKey, files: result.value.files, error: null }
          : { key: requestKey, files: null, error: result.error },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [root, section, path, revision]);

  const current = loaded !== null && loaded.key === key ? loaded : null;
  const file = current?.files?.find((entry) => entry.path === path) ?? null;

  // An amend can run with nothing staged (it only rewrites the last message), and an empty
  // message means "keep the existing one". An ordinary commit needs both a stage and a message.
  const stagedCount = state === null ? 0 : entriesFor(state, 'staged').length;
  const disabledReason = amend
    ? null
    : stagedCount === 0
      ? 'nothing staged'
      : message.trim() === ''
        ? 'a commit needs a message'
        : null;

  return (
    <div
      className="card working-tree"
      data-testid="working-tree"
      // Focusable by script, not by tab: it is a destination the WIP node points at, and a card in
      // the tab order would be one more stop between the reader and the controls inside it.
      tabIndex={-1}
      {...(cardRef === undefined ? {} : { ref: cardRef })}
    >
      <h2>
        <TreeIcon size={13} />
        Working tree
      </h2>
      {state === null ? (
        <p className="empty">nothing loaded</p>
      ) : (
        <>
          <p className="headline">{describeHead(state)}</p>
          {SECTIONS.map((spec) => {
            const entries = entriesFor(state, spec.section);
            if (entries.length === 0) return null;
            return (
              <section
                className="wt-section"
                data-testid="wt-section"
                data-section={spec.section}
                key={spec.section}
              >
                <h3>{spec.title}</h3>
                <ul className="entries">
                  {entries.map((entry) => {
                    const kind = fileKind(entry.path);
                    const KindIcon = KIND_ICON[kind];
                    const active = section === spec.section && path === entry.path;
                    return (
                      <li key={`${spec.section}:${entry.path}`}>
                        <button
                          type="button"
                          data-testid="entry-item"
                          data-path={entry.path}
                          data-kind={kind}
                          data-submodule={entry.submodule ?? undefined}
                          className={active ? 'entry-item selected' : 'entry-item'}
                          onClick={() => setSelected({ section: spec.section, path: entry.path })}
                        >
                          <span className="entry-kind" data-testid="entry-kind" aria-hidden="true">
                            {/* 16 rather than 14: the family mark has to be legible in a column
                                that a person scans, and a mark inside a page outline loses a third
                                of its size to the outline. */}
                            <KindIcon size={16} />
                          </span>
                          {entry.submodule === null ? null : (
                            <span
                              className="fsubmodule"
                              data-testid="entry-submodule"
                              data-state={entry.submodule}
                              title={`submodule: ${entry.submodule}`}
                            >
                              ⧉
                            </span>
                          )}
                          <span className="ename">{entry.path}</span>
                          <span className="status-code">{entryCode(entry)}</span>
                        </button>
                        {onStage !== undefined &&
                          (spec.section === 'unstaged' ||
                            spec.section === 'untracked' ||
                            // A conflicted path is resolved by `git add`, which is the same
                            // command under a different name: git's own word for it is "resolved".
                            spec.section === 'conflicted') && (
                            <button
                              type="button"
                              className="stage"
                              disabled={busy === true}
                              onClick={() => onStage(entry.path)}
                            >
                              {spec.section === 'conflicted' ? 'resolve' : 'stage'}
                            </button>
                          )}
                        {onTakeSide !== undefined && spec.section === 'conflicted' && (
                          <>
                            <button
                              type="button"
                              className="stage"
                              data-testid="take-ours"
                              disabled={busy === true}
                              onClick={() => onTakeSide('ours', entry.path)}
                            >
                              ours
                            </button>
                            <button
                              type="button"
                              className="stage"
                              data-testid="take-theirs"
                              disabled={busy === true}
                              onClick={() => onTakeSide('theirs', entry.path)}
                            >
                              theirs
                            </button>
                          </>
                        )}
                        {onDiscard !== undefined &&
                          (spec.section === 'unstaged' || spec.section === 'untracked') && (
                            <button
                              type="button"
                              className="stage danger"
                              data-testid="discard-button"
                              disabled={busy === true}
                              onClick={() => onDiscard(entry.path)}
                            >
                              discard
                            </button>
                          )}
                        {/* The two that leave the window, on the row they are about. They appear on
                            hover like `stage`, so the row stays a row of names until it is pointed at. */}
                        {onOpenFile === undefined ? null : (
                          <button
                            type="button"
                            className="stage"
                            data-testid="open-file"
                            disabled={busy === true}
                            title={`open ${entry.path} with the machine's own application`}
                            onClick={() => onOpenFile(entry.path)}
                          >
                            open
                          </button>
                        )}
                        {onRevealFile === undefined ? null : (
                          <button
                            type="button"
                            className="stage"
                            data-testid="reveal-file"
                            disabled={busy === true}
                            title={`show ${entry.path} in the file manager`}
                            onClick={() => onRevealFile(entry.path)}
                          >
                            reveal
                          </button>
                        )}
                        {onUnstage !== undefined && spec.section === 'staged' && (
                          <button
                            type="button"
                            className="stage"
                            data-testid="unstage-button"
                            disabled={busy === true}
                            onClick={() => onUnstage(entry.path)}
                          >
                            unstage
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
          {/* Only reached when every entry is ignored: ignored files get no section. */}
          {state.entries.every((entry) => entry.kind === 'ignored') && state.entries.length > 0 && (
            <p className="empty">clean apart from ignored files</p>
          )}
          {state.entries.length === 0 && <p className="empty">clean</p>}
          {onCommit !== undefined && (
            <div className="commit-box" data-testid="commit-box">
              <input
                className="commit-summary"
                data-testid="commit-message"
                placeholder="Summary"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
              />
              <textarea
                className="commit-body"
                data-testid="commit-body"
                placeholder="Description (optional)"
                rows={3}
                value={body}
                onChange={(event) => setBody(event.target.value)}
              />
              <label className="commit-amend">
                <input
                  type="checkbox"
                  data-testid="commit-amend"
                  checked={amend}
                  onChange={(event) => setAmend(event.target.checked)}
                />
                amend the last commit
              </label>
              {disabledReason !== null && (
                <p className="commit-disabled-reason" data-testid="commit-disabled-reason">
                  {disabledReason}
                </p>
              )}
              <button
                type="button"
                className="primary"
                data-testid="commit-button"
                disabled={disabledReason !== null || committing}
                onClick={() => {
                  setCommitting(true);
                  void onCommit(message, body, amend)
                    .then((committed) => {
                      if (committed) {
                        setMessage('');
                        setBody('');
                        setAmend(false);
                      }
                    })
                    .finally(() => setCommitting(false));
                }}
              >
                Commit
              </button>
              {onCommitAndPush === undefined ? null : (
                <button
                  type="button"
                  className="primary"
                  data-testid="commit-and-push-button"
                  disabled={disabledReason !== null || committing}
                  onClick={() => {
                    setCommitting(true);
                    void onCommitAndPush(message, body, amend)
                      .then((committed) => {
                        if (committed) {
                          setMessage('');
                          setBody('');
                          setAmend(false);
                        }
                      })
                      .finally(() => setCommitting(false));
                  }}
                >
                  Commit and push
                </button>
              )}
            </div>
          )}
        </>
      )}
      <div className="wt-diff" data-testid="wt-diff">
        {/* Untracked files have no blame to offer: they are in no commit, so every line would come
            back as "not committed yet" and the button would be a promise the pane cannot keep. */}
        {path === null || section === 'untracked' ? null : (
          /* Two buttons that say what they do: `role="group"` here would only be a promise that the
             two belong together, which the labels already say. */
          <div className="wt-view">
            <button
              type="button"
              className={view === 'diff' ? 'wt-view-button on' : 'wt-view-button'}
              data-testid="view-diff"
              onClick={() => setView('diff')}
            >
              diff
            </button>
            <button
              type="button"
              className={view === 'blame' ? 'wt-view-button on' : 'wt-view-button'}
              data-testid="view-blame"
              onClick={() => setView('blame')}
            >
              blame
            </button>
            <button
              type="button"
              className={view === 'history' ? 'wt-view-button on' : 'wt-view-button'}
              data-testid="view-history"
              onClick={() => setView('history')}
            >
              history
            </button>
          </div>
        )}
        {view === 'history' && path !== null && section !== 'untracked' ? (
          <HistoryView
            path={path}
            loaded={history !== null && history.key === key ? history : null}
            {...(onSelectCommit === undefined ? {} : { onSelectCommit })}
          />
        ) : null}
        {view === 'blame' && path !== null && section !== 'untracked' ? (
          <BlameView
            path={path}
            loaded={blame !== null && blame.key === key ? blame : null}
            {...(onSelectCommit === undefined ? {} : { onSelectCommit })}
          />
        ) : view === 'history' && path !== null && section !== 'untracked' ? null : (
          <>
            {section === 'conflicted' && onAbortMerge !== undefined ? (
              <ConflictPanel
                root={root}
                path={path}
                {...(busy === undefined ? {} : { busy })}
                {...(revision === undefined ? {} : { revision })}
                onResolve={(region, take, content) =>
                  onResolveRegion?.(path ?? '', region, take, content)
                }
                onSave={(content) => onSaveConflict?.(path ?? '', content)}
                onAbort={onAbortMerge}
              />
            ) : null}
            {/* The file's own diff still renders below, conflict markers and all: the panel is the
                versions git holds, and the diff is what the file itself says. P1 asked for the markers
                to be visible, and a screen that replaced them would be a regression wearing a feature's
                clothes. */}
            {section === 'untracked' ? (
              <p className="empty">
                {path} is untracked: it is in neither the index nor any commit, so there is no diff
                to show yet. Stage it to start tracking it.
              </p>
            ) : path === null ? (
              <p className="empty">Select a file to see its diff.</p>
            ) : current === null ? (
              <p className="empty">loading…</p>
            ) : current.error !== null ? (
              <p className="empty">{current.error}</p>
            ) : file !== null ? (
              <DiffView
                file={file}
                {...(onDiscardHunk === undefined
                  ? {}
                  : { onDiscardHunk: (hunk: number) => onDiscardHunk(path ?? '', hunk) })}
              />
            ) : (
              <p className="empty">no diff for {path}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function entryCode(entry: StatusEntry): string {
  if (entry.kind === 'untracked') return '??';
  if (entry.kind === 'ignored') return '!!';
  if (entry.kind === 'unmerged') return 'UU';
  return `${entry.index === 'unmodified' ? '.' : codeLetter(entry.index)}${entry.worktree === 'unmodified' ? '.' : codeLetter(entry.worktree)}`;
}

function codeLetter(status: string): string {
  return status === 'typechange' ? 'T' : status.slice(0, 1).toUpperCase();
}

function describeHead(state: RepoState): string {
  if (state.head.kind === 'branch') {
    const tracking =
      state.head.upstream === null
        ? ''
        : ` · ${state.head.ahead}↑ ${state.head.behind}↓ ${state.head.upstream}`;
    return `on ${state.head.name}${tracking}`;
  }
  if (state.head.kind === 'unborn')
    return `on ${state.head.name ?? 'an unnamed branch'} — no commits yet`;
  return `detached at ${state.head.oid.slice(0, 7)}`;
}
