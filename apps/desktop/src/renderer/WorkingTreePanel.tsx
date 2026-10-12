import { useEffect, useState } from 'react';
import type { DiffFile, RepoState, StatusEntry } from '../shared/api.ts';
import { DiffView } from './DiffView.tsx';
import { fileKind, type FileKind } from './fileKind.ts';
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
  readonly root: string | null;
  readonly state: RepoState | null;
  readonly busy?: boolean;
  /** The callbacks run the real operations through the app's one `run` path. */
  readonly onStage?: (path: string) => void;
  readonly onUnstage?: (path: string) => void;
  /** `true` means the commit ran; the message is only cleared when it did. */
  readonly onCommit?: (message: string, amend: boolean) => Promise<boolean>;
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

export function WorkingTreePanel({
  root,
  state,
  busy,
  onStage,
  onUnstage,
  onCommit,
}: WorkingTreePanelProps): React.ReactElement {
  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [selected, setSelected] = useState<{
    readonly section: WorkingTreeSection;
    readonly path: string;
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

  useEffect(() => {
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
  }, [root, section, path]);

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
    <div className="card working-tree" data-testid="working-tree">
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
                            <KindIcon />
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
                          (spec.section === 'unstaged' || spec.section === 'untracked') && (
                            <button
                              type="button"
                              className="stage"
                              disabled={busy === true}
                              onClick={() => onStage(entry.path)}
                            >
                              stage
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
              <textarea
                className="commit-message"
                data-testid="commit-message"
                placeholder="Commit message"
                rows={3}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
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
                  void onCommit(message, amend)
                    .then((committed) => {
                      if (committed) {
                        setMessage('');
                        setAmend(false);
                      }
                    })
                    .finally(() => setCommitting(false));
                }}
              >
                Commit
              </button>
            </div>
          )}
        </>
      )}
      <div className="wt-diff" data-testid="wt-diff">
        {section === 'untracked' ? (
          <p className="empty">
            {path} is untracked: it is in neither the index nor any commit, so there is no diff to
            show yet. Stage it to start tracking it.
          </p>
        ) : path === null ? (
          <p className="empty">Select a file to see its diff.</p>
        ) : current === null ? (
          <p className="empty">loading…</p>
        ) : current.error !== null ? (
          <p className="empty">{current.error}</p>
        ) : file !== null ? (
          <DiffView file={file} />
        ) : (
          <p className="empty">no diff for {path}</p>
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
