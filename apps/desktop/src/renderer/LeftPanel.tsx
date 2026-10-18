import { useState } from 'react';
import type { IdentityValue, Ref } from '../shared/api.ts';
import {
  BranchIcon,
  ChevronDownIcon,
  FileConfigIcon,
  FolderIcon,
  RemoteIcon,
  TagIcon,
} from './icons.tsx';

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
  /**
   * The other working directories of this repository, and which of them are already open.
   *
   * A tab *is* a path, so opening one of these is opening a path: the model did not have to change
   * for a worktree to get a tab, and that is worth knowing rather than designing around.
   */
  readonly worktrees: readonly {
    readonly path: string;
    readonly branch: string | null;
    readonly bare: boolean;
    readonly detached: boolean;
    readonly locked: string | null;
    readonly prunable: string | null;
  }[];
  readonly openPaths: readonly string[];
  readonly onOpenWorktree: (path: string) => void;
  /**
   * Who commits will be authored as, and where each part of it came from.
   *
   * Shown rather than left behind a `git config` in a terminal: a repository with two identities
   * configured is the case this is for, and the question a person has is which file won.
   */
  readonly identity: {
    readonly name: IdentityValue | null;
    readonly email: IdentityValue | null;
    readonly signingKey: IdentityValue | null;
  } | null;
  /** The remotes the config holds. Forgetting one is a `local` operation: it is config, not work. */
  readonly remotes: readonly {
    readonly name: string;
    readonly fetchUrl: string | null;
    readonly pushUrl: string | null;
  }[];
  readonly onAddRemote: () => void;
  readonly onRenameRemote: (name: string) => void;
  readonly onSetRemoteUrl: (name: string, url: string) => void;
  readonly onRemoveRemote: (name: string) => void;
  readonly submodules: readonly { readonly path: string; readonly state: string }[];
  /** `*` is every ref; anything else is the revision the graph is read from. */
  readonly filter: string;
  /**
   * The names the picture is not drawing.
   *
   * A question about the *picture* and never about the repository: nothing is written, and the rows
   * are still here — a hidden name that vanished from the list would be a name nobody could bring
   * back.
   */
  readonly hidden: readonly string[];
  readonly busy?: boolean;
  readonly onFilter: (revision: string) => void;
  readonly onSwitch: (ref: Ref) => void;
  /**
   * Shows what this branch has that the one being read does not, and the other way round.
   *
   * Disabled for the branch that is checked out, like `switch`: comparing a branch with itself is an
   * empty answer rather than a slow one, and a button that does nothing is worse than a disabled one.
   */
  readonly onCompare: (ref: Ref) => void;
  /**
   * What the graph is being searched for, and the handler that narrows it.
   *
   * A search of the *repository*, not of the list the window holds: the graph carries a page of the
   * history, and searching a page is not searching the history. Nothing is written — it is a question
   * about the picture, like the filter and the hidden names beside it.
   */
  readonly search: {
    readonly grep?: string;
    readonly author?: string;
    readonly since?: string;
    readonly until?: string;
  };
  readonly onSearch: (search: {
    readonly grep?: string;
    readonly author?: string;
    readonly since?: string;
    readonly until?: string;
    readonly mine?: boolean;
  }) => void;
  readonly onMerge: (ref: Ref) => void;
  readonly onRename: (ref: Ref) => void;
  readonly onDelete: (ref: Ref) => void;
  readonly onToggleHide: (ref: Ref) => void;
}

/**
 * A section of names: a header that collapses it, and the count of what is *shown* — a header that
 * said `Local 12` over a list of two would be counting something the reader cannot see.
 */
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

/** One part of the identity, in the order the card reads. */
const IDENTITY_PARTS = [
  { key: 'name', label: 'name' },
  { key: 'email', label: 'email' },
  { key: 'signing key', label: 'sign' },
] as const;

/**
 * The search form: four fields and a checkbox, submitted rather than typed live.
 *
 * Submitted on purpose — a search that ran on every keystroke would be a git call per letter, and on a
 * large repository that is a picture that never settles. `only mine` is a checkbox and not a fifth
 * field because it is not a string somebody remembers: it is the address the repository is configured
 * with, and the app reads it from the identity card.
 */
function SearchSection({
  search,
  onSearch,
  busy,
}: {
  readonly search: {
    readonly grep?: string;
    readonly author?: string;
    readonly since?: string;
    readonly until?: string;
  };
  readonly onSearch: (search: {
    readonly grep?: string;
    readonly author?: string;
    readonly since?: string;
    readonly until?: string;
    readonly mine?: boolean;
  }) => void;
  readonly busy?: boolean;
}): React.ReactElement {
  const [grep, setGrep] = useState(search.grep ?? '');
  const [author, setAuthor] = useState(search.author ?? '');
  const [since, setSince] = useState(search.since ?? '');
  const [until, setUntil] = useState(search.until ?? '');
  const [mine, setMine] = useState(false);
  const active =
    search.grep !== undefined ||
    search.author !== undefined ||
    search.since !== undefined ||
    search.until !== undefined;

  const submit = (): void => {
    onSearch({ grep, author, since, until, mine });
  };

  return (
    <details className="panel-section" data-testid="panel-section" data-section="Search" open>
      <summary>
        <ChevronDownIcon size={12} />
        <span className="panel-title">Search</span>
        {active ? <span className="panel-count">on</span> : null}
      </summary>
      {(
        [
          { key: 'grep', label: 'message', value: grep, set: setGrep },
          { key: 'author', label: 'author', value: author, set: setAuthor },
          { key: 'since', label: 'since', value: since, set: setSince },
          { key: 'until', label: 'until', value: until, set: setUntil },
        ] as const
      ).map((field) => (
        <input
          key={field.key}
          type="search"
          className="panel-search"
          data-testid={`search-${field.key}`}
          placeholder={field.label}
          aria-label={`Search by ${field.label}`}
          value={field.value}
          onChange={(event) => field.set(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
          }}
        />
      ))}
      <label className="panel-row search-mine">
        <input
          type="checkbox"
          data-testid="search-mine"
          checked={mine}
          onChange={(event) => setMine(event.currentTarget.checked)}
        />
        only mine
      </label>
      <div className="panel-row">
        <button
          type="button"
          className="stage"
          data-testid="search-apply"
          disabled={busy === true}
          onClick={submit}
        >
          search
        </button>
        {active ? (
          <button
            type="button"
            className="stage"
            data-testid="search-clear"
            disabled={busy === true}
            onClick={() => {
              setGrep('');
              setAuthor('');
              setSince('');
              setUntil('');
              setMine(false);
              onSearch({});
            }}
          >
            clear
          </button>
        ) : null}
      </div>
    </details>
  );
}

export function LeftPanel({
  refs,
  worktrees,
  openPaths,
  onOpenWorktree,
  identity,
  remotes,
  onAddRemote,
  onRenameRemote,
  onSetRemoteUrl,
  onRemoveRemote,
  submodules,
  filter,
  hidden,
  busy,
  onFilter,
  onSwitch,
  onCompare,
  search,
  onSearch,
  onMerge,
  onRename,
  onDelete,
  onToggleHide,
}: LeftPanelProps): React.ReactElement {
  /**
   * The filter is here because a panel of names is worth less than the names it holds — which, on a
   * repository with forty branches, is the difference between a list and a place to look.
   *
   * It filters what is *shown*: nothing is read again, so typing is not a git call and the graph does
   * not move under the reader's hands. One filter for both kinds of row: a ref has a `shortName` and
   * a submodule has a `path`, and the question asked of each is the same one.
   */
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const matching = <T extends { readonly shortName: string } | { readonly path: string }>(
    list: readonly T[],
  ): readonly T[] =>
    needle === ''
      ? list
      : list.filter((entry) =>
          ('shortName' in entry ? entry.shortName : entry.path).toLowerCase().includes(needle),
        );

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
      {hidden.includes(ref.shortName) ? (
        <span className="panel-note" data-testid="ref-hidden">
          hidden
        </span>
      ) : null}
      {ref.isHead ? <span className="panel-current">current</span> : null}
      {ref.kind === 'branch' ? (
        <button
          type="button"
          className="stage"
          data-testid="ref-compare"
          disabled={busy === true || ref.isHead}
          onClick={() => onCompare(ref)}
        >
          compare
        </button>
      ) : null}
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
        className="stage"
        data-testid="ref-hide"
        disabled={busy === true}
        onClick={() => onToggleHide(ref)}
      >
        {hidden.includes(ref.shortName) ? 'show' : 'hide'}
      </button>
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

      <input
        type="search"
        className="panel-search"
        data-testid="panel-search"
        placeholder="Filter names"
        aria-label="Filter branches, remotes, tags and submodules"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />

      <SearchSection
        search={search}
        onSearch={onSearch}
        {...(busy === undefined ? {} : { busy })}
      />

      <Section
        title="Local"
        refs={matching(refs.filter((ref) => ref.kind === 'branch'))}
        render={row}
      />
      <Section
        title="Remote branches"
        refs={matching(refs.filter((ref) => ref.kind === 'remote'))}
        render={row}
      />

      {/* The configuration, which is a different question from the branches that came from it: a
          remote nothing has been fetched from has no branches and is still a remote. */}
      <details className="panel-section" data-testid="panel-section" data-section="Remotes" open>
        <summary>
          <ChevronDownIcon size={12} />
          <span className="panel-title">Remotes</span>
          <span className="panel-count">{remotes.length}</span>
        </summary>
        <ul className="panel-list">
          <li className="panel-row">
            <button
              type="button"
              className="stage"
              data-testid="remote-add"
              disabled={busy === true}
              onClick={onAddRemote}
            >
              add…
            </button>
          </li>
          {remotes.map((remote) => (
            <li
              key={remote.name}
              className="panel-row"
              data-testid="remote-row"
              data-remote={remote.name}
            >
              <span className="panel-name" title={remote.fetchUrl ?? ''}>
                <span className="entry-kind" aria-hidden="true">
                  <RemoteIcon size={14} />
                </span>
                {remote.name}
              </span>
              <span className="panel-note remote-url" title={remote.pushUrl ?? ''}>
                {remote.pushUrl !== null && remote.pushUrl !== remote.fetchUrl
                  ? `push → ${remote.pushUrl}`
                  : (remote.fetchUrl ?? '')}
              </span>
              <button
                type="button"
                className="stage"
                data-testid="remote-rename"
                disabled={busy === true}
                onClick={() => onRenameRemote(remote.name)}
              >
                rename
              </button>
              <button
                type="button"
                className="stage"
                data-testid="remote-url"
                disabled={busy === true}
                onClick={() => onSetRemoteUrl(remote.name, remote.fetchUrl ?? '')}
              >
                url
              </button>
              <button
                type="button"
                className="stage danger"
                data-testid="remote-remove"
                disabled={busy === true}
                onClick={() => onRemoveRemote(remote.name)}
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      </details>
      <Section
        title="Tags"
        refs={matching(refs.filter((ref) => ref.kind === 'tag'))}
        render={row}
      />

      {identity === null ? null : (
        <details className="panel-section" data-testid="panel-section" data-section="Identity" open>
          <summary>
            <ChevronDownIcon size={12} />
            <span className="panel-title">Identity</span>
            {/* No count: three questions with three answers, and a number here would be counting the
                parts of one name. */}
          </summary>
          <ul className="panel-list">
            {IDENTITY_PARTS.map((part) => {
              const value = part.key === 'signing key' ? identity.signingKey : identity[part.key];
              return (
                <li
                  key={part.key}
                  className="panel-row identity-row"
                  data-testid="identity-row"
                  data-part={part.key}
                >
                  <span className="panel-note">{part.label}</span>
                  <span
                    className="identity-value"
                    data-testid="identity-value"
                    title={value?.origin}
                  >
                    {value?.value ?? 'unset'}
                  </span>
                  <span className="panel-note">{value === null ? '' : `from ${value.scope}`}</span>
                </li>
              );
            })}
          </ul>
        </details>
      )}

      <details className="panel-section" data-testid="panel-section" data-section="Worktrees" open>
        <summary>
          <ChevronDownIcon size={12} />
          <span className="panel-title">Worktrees</span>
          <span className="panel-count">{worktrees.length}</span>
        </summary>
        {worktrees.length < 2 ? (
          <p className="empty">this one only</p>
        ) : (
          <ul className="panel-list">
            {worktrees.map((entry) => (
              <li
                key={entry.path}
                className="panel-row"
                data-testid="worktree-row"
                data-path={entry.path}
              >
                <button
                  type="button"
                  className="panel-name"
                  data-testid="worktree-open"
                  title={entry.path}
                  disabled={openPaths.includes(entry.path)}
                  onClick={() => onOpenWorktree(entry.path)}
                >
                  <span className="entry-kind" aria-hidden="true">
                    <FolderIcon size={14} />
                  </span>
                  {entry.path.split('/').pop() ?? entry.path}
                  {entry.locked === null ? null : <span className="panel-note">locked</span>}
                  {entry.prunable === null ? null : <span className="panel-note">prunable</span>}
                </button>
                <span className="panel-note">
                  {entry.bare ? 'bare' : entry.detached ? 'detached' : (entry.branch ?? '?')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </details>

      <details className="panel-section" data-testid="panel-section" data-section="Submodules" open>
        <summary>
          <ChevronDownIcon size={12} />
          <span className="panel-title">Submodules</span>
          <span className="panel-count">{submodules.length}</span>
        </summary>
        {matching(submodules).length === 0 ? (
          <p className="empty">none</p>
        ) : (
          <ul className="panel-list">
            {matching(submodules).map((entry) => (
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
