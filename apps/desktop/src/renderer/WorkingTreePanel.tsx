import { useEffect, useState } from 'react';
import type { DiffFile, RepoState, StatusEntry } from '../shared/api.ts';
import { DiffView } from './DiffView.tsx';
import { fileKind, kindGlyph } from './fileKind.ts';

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
  /** Staging is still the only mutation in this pane; the callback runs the real `add`. */
  readonly onStage?: (path: string) => void;
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
}: WorkingTreePanelProps): React.ReactElement {
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

  return (
    <div className="card working-tree" data-testid="working-tree">
      <h2>Working tree</h2>
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
                    const active = section === spec.section && path === entry.path;
                    return (
                      <li key={`${spec.section}:${entry.path}`}>
                        <button
                          type="button"
                          data-testid="entry-item"
                          data-path={entry.path}
                          data-kind={kind}
                          className={active ? 'entry-item selected' : 'entry-item'}
                          onClick={() => setSelected({ section: spec.section, path: entry.path })}
                        >
                          <span className="entry-kind" data-testid="entry-kind" aria-hidden="true">
                            {kindGlyph(kind)}
                          </span>
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
