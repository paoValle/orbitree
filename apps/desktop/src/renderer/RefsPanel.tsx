import type { Ref } from '../shared/api.ts';
import { BranchIcon, TagIcon, TreeIcon } from './icons.tsx';

/**
 * The local branches and the tags, with the three things a person does to a name: go there,
 * rename it, delete it.
 *
 * A row of buttons rather than a menu, which is the vocabulary the working tree already uses for
 * `stage` and `discard`: the same gesture in both panes is one thing to learn. Deleting is the
 * guarded half — a tag deletion is destructive and opens the confirmation sheet, and `git branch
 * -d` refuses an unmerged branch by itself, which is its own kind of guard.
 */
export interface RefsPanelProps {
  readonly refs: readonly Ref[];
  readonly busy?: boolean;
  readonly onSwitch: (ref: Ref) => void;
  /** Merges this branch into the one that is checked out, which is what a merge always is. */
  readonly onMerge: (ref: Ref) => void;
  readonly onRename: (ref: Ref) => void;
  readonly onDelete: (ref: Ref) => void;
}

export function RefsPanel({
  refs,
  busy,
  onSwitch,
  onMerge,
  onRename,
  onDelete,
}: RefsPanelProps): React.ReactElement {
  // Branches first, then tags, each in the order git listed them: the order a reader looks for a
  // name in when something has just been created or renamed.
  const branches = refs.filter((ref) => ref.kind === 'branch');
  const tags = refs.filter((ref) => ref.kind === 'tag');

  return (
    <div className="card" data-testid="refs">
      <h2>
        <TreeIcon size={13} />
        Branches and tags
      </h2>
      {branches.length === 0 && tags.length === 0 ? (
        <p className="empty">no branches and no tags yet</p>
      ) : (
        <ul className="ref-list" data-testid="ref-list">
          {[...branches, ...tags].map((ref) => (
            <li key={ref.name} className="ref-row" data-testid="ref-row" data-ref={ref.shortName}>
              <span className="entry-kind" aria-hidden="true">
                {ref.kind === 'tag' ? <TagIcon size={16} /> : <BranchIcon size={16} />}
              </span>
              <span className="ref-name">{ref.shortName}</span>
              {ref.isHead ? <span className="ref-current">current</span> : null}
              <button
                type="button"
                className="stage"
                data-testid="ref-switch"
                disabled={busy === true || ref.isHead}
                onClick={() => onSwitch(ref)}
              >
                switch
              </button>
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
          ))}
        </ul>
      )}
    </div>
  );
}
