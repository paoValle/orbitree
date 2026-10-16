import type { Ref } from '../shared/api.ts';
import { BranchIcon, ChevronDownIcon, FileConfigIcon, RemoteIcon, TagIcon } from './icons.tsx';

/**
 * The left panel: the names a repository has, in sections.
 *
 * Local branches, remote branches, tags and submodules, each in its own section, each collapsible —
 * with `<details>`, so the collapsing, the keyboard and the announcement to a screen reader are the
 * platform's rather than a second implementation of them.
 *
 * Clicking a name is what the `All branches` dropdown used to do: it reads the graph from that
 * revision, and clicking it again goes back to every ref. The ref actions live on the row they act
 * on, which is where the working tree already puts `stage` and `discard`, so the same gesture in two
 * panes is one thing to learn.
 *
 * Stashes are deliberately **not** here, although the analysis that asked for this panel listed them
 * among the sections: a stash is a commit with a patch, and a patch belongs in the wide column that
 * can show it rather than in a narrow panel of names. They keep their card, which already reads,
 * previews and applies them.
 */
export interface LeftPanelProps {
  readonly refs: readonly Ref[];
  readonly submodules: readonly { readonly path: string; readonly state: string }[];
  /** `*` is every ref; anything else is the revision the graph is read from. */
  readonly filter: string;
  readonly busy?: boolean;
  readonly onFilter: (revision: string) => void;
  readonly onSwitch: (ref: Ref) => void;
  readonly onMerge: (ref: Ref) => void;
  readonly onRename: (ref: Ref) => void;
  readonly onDelete: (ref: Ref) => void;
}

function Section({
  title,
  refs,
  render,
}: {
  readonly title: string;
  readonly refs: readonly Ref[];
  readonly render: (ref: Ref) => React.ReactElement;
}): React.ReactElement {
  return (
    <details className="panel-section" data-testid="panel-section" data-section={title} open>
      <summary>
        <ChevronDownIcon size={12} />
        <span className="panel-title">{title}</span>
        <span className="panel-count">{refs.length}</span>
      </summary>
      {refs.length === 0 ? (
        <p className="empty">none</p>
      ) : (
        <ul className="panel-list">{refs.map(render)}</ul>
      )}
    </details>
  );
}

export function LeftPanel({
  refs,
  submodules,
  filter,
  busy,
  onFilter,
  onSwitch,
  onMerge,
  onRename,
  onDelete,
}: LeftPanelProps): React.ReactElement {
  const glyph = (kind: Ref['kind']): React.ReactElement =>
    kind === 'tag' ? (
      <TagIcon size={14} />
    ) : kind === 'remote' ? (
      <RemoteIcon size={14} />
    ) : (
      <BranchIcon size={14} />
    );

  const row = (ref: Ref): React.ReactElement => (
    <li key={ref.name} className="panel-row" data-testid="ref-row" data-ref={ref.shortName}>
      <button
        type="button"
        className={filter === ref.shortName ? 'panel-name selected' : 'panel-name'}
        data-testid="ref-read"
        title={`Read the history of ${ref.shortName}`}
        onClick={() => onFilter(filter === ref.shortName ? '*' : ref.shortName)}
      >
        <span className="entry-kind" aria-hidden="true">
          {glyph(ref.kind)}
        </span>
        {ref.shortName}
      </button>
      {ref.isHead ? <span className="panel-current">current</span> : null}
      {ref.kind === 'branch' && !ref.isHead ? (
        <button
          type="button"
          className="stage"
          data-testid="ref-merge"
          disabled={busy === true}
          onClick={() => onMerge(ref)}
        >
          merge
        </button>
      ) : null}
      {ref.kind === 'remote' ? null : (
        <button
          type="button"
          className="stage"
          data-testid="ref-switch"
          disabled={busy === true || ref.isHead}
          onClick={() => onSwitch(ref)}
        >
          switch
        </button>
      )}
      {ref.kind === 'branch' ? (
        <button
          type="button"
          className="stage"
          data-testid="ref-rename"
          disabled={busy === true}
          onClick={() => onRename(ref)}
        >
          rename
        </button>
      ) : null}
      <button
        type="button"
        className="stage danger"
        data-testid="ref-delete"
        disabled={busy === true}
        onClick={() => onDelete(ref)}
      >
        delete
      </button>
    </li>
  );

  return (
    <nav className="panel" data-testid="left-panel" aria-label="Branches, tags and submodules">
      <div className="panel-row">
        <button
          type="button"
          className={filter === '*' ? 'panel-name selected' : 'panel-name'}
          data-testid="ref-all"
          onClick={() => onFilter('*')}
        >
          every branch and tag
        </button>
      </div>

      <Section title="Local" refs={refs.filter((ref) => ref.kind === 'branch')} render={row} />
      <Section title="Remote" refs={refs.filter((ref) => ref.kind === 'remote')} render={row} />
      <Section title="Tags" refs={refs.filter((ref) => ref.kind === 'tag')} render={row} />

      <details className="panel-section" data-testid="panel-section" data-section="Submodules" open>
        <summary>
          <ChevronDownIcon size={12} />
          <span className="panel-title">Submodules</span>
          <span className="panel-count">{submodules.length}</span>
        </summary>
        {submodules.length === 0 ? (
          <p className="empty">none</p>
        ) : (
          <ul className="panel-list">
            {submodules.map((entry) => (
              <li
                key={entry.path}
                className="panel-row"
                data-testid="submodule-row"
                data-path={entry.path}
              >
                <span className="entry-kind" aria-hidden="true">
                  <FileConfigIcon size={14} />
                </span>
                <span className="panel-name static">{entry.path}</span>
                <span className="panel-note">{entry.state}</span>
              </li>
            ))}
          </ul>
        )}
      </details>
    </nav>
  );
}
