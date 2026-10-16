import { useEffect, useState } from 'react';

/**
 * A conflicted path: the three versions git is holding, and one row per region of the conflict.
 *
 * The three whole-file sides come from the index stages; the regions come from the file itself, in
 * the order the markers appear in it. A region is resolved by replacing it — with one side, with
 * both, or with text typed here — and resolving one renumbers the rest, so the list is re-read
 * after every resolution rather than kept. Choosing region 2 of a list that is no longer current is
 * how the wrong region gets resolved, silently.
 *
 * Reading is all this does. Choosing a side for the whole file is a row's own button, marking it
 * resolved is `git add`, and giving the merge up is the button above.
 */
export interface ConflictRegionView {
  readonly start: number;
  readonly end: number;
  readonly ours: readonly string[];
  readonly theirs: readonly string[];
}

export interface ConflictPanelProps {
  readonly root: string | null;
  readonly path: string | null;
  readonly busy?: boolean;
  /** Bumped after every operation, so the regions are read again: resolving one renumbers them. */
  readonly revision?: number;
  readonly onResolve: (
    region: number,
    take: 'ours' | 'theirs' | 'both' | 'custom',
    content?: string,
  ) => void;
  readonly onAbort: () => void;
}

const SIDES = ['base', 'ours', 'theirs'] as const;

export function ConflictPanel({
  root,
  path,
  busy,
  revision,
  onResolve,
  onAbort,
}: ConflictPanelProps): React.ReactElement {
  const [sides, setSides] = useState<Readonly<Record<string, string>> | null>(null);
  const [regions, setRegions] = useState<readonly ConflictRegionView[] | null>(null);
  const [editing, setEditing] = useState<{ readonly region: number; readonly text: string } | null>(
    null,
  );

  useEffect(() => {
    // `revision` is a trigger rather than a value: resolving a region renumbers the rest, so the
    // list has to be read again after every operation, and the comment is the reference the rule
    // is looking for.
    void revision;
    if (root === null || path === null) return;
    let cancelled = false;
    void Promise.all(
      SIDES.map(async (side) => {
        const result = await window.orbitree.readConflictSide({ path: root, file: path, side });
        // A missing stage is a state, not a failure: a file added on one side and modified on the
        // other has no common ancestor at all, and the screen says so rather than pretending the
        // file was empty.
        return [side, result.ok ? result.value.content : ''] as const;
      }),
    ).then((loaded) => {
      if (!cancelled) setSides(Object.fromEntries(loaded));
    });

    void window.orbitree.readConflictRegions({ path: root, file: path }).then((result) => {
      if (cancelled) return;
      setRegions(result.ok ? result.value.regions : []);
      // A region that was on screen and is not any more is a region that has been resolved, so the
      // text box for it goes away with it.
      setEditing((current) =>
        current !== null && result.ok && current.region < result.value.regions.length
          ? current
          : null,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [root, path, revision]);

  const resolve = (region: number, take: 'ours' | 'theirs' | 'both' | 'custom'): void => {
    setEditing(null);
    onResolve(region, take, undefined);
  };

  return (
    <div className="conflict" data-testid="conflict">
      <div className="conflict-head">
        <span className="conflict-title">
          conflict in <code>{path ?? ''}</code>
        </span>
        <button
          type="button"
          className="stage danger"
          data-testid="merge-abort"
          disabled={busy === true}
          onClick={onAbort}
        >
          abort the merge
        </button>
      </div>

      {regions === null ? null : regions.length === 0 ? (
        <p className="empty">no conflict markers left: mark it resolved to finish</p>
      ) : (
        <ul className="region-list" data-testid="region-list">
          {regions.map((region, index) => (
            <li className="region" data-testid="conflict-region" key={region.start}>
              <div className="region-head">
                <span className="region-name">region {index + 1}</span>
                <span className="region-sides" data-testid="region-sides">
                  {region.ours.length === 0 ? '(ours is empty)' : region.ours.join(' ⏎ ')}
                  <em> / </em>
                  {region.theirs.length === 0 ? '(theirs is empty)' : region.theirs.join(' ⏎ ')}
                </span>
                <button
                  type="button"
                  className="stage"
                  data-testid="region-ours"
                  disabled={busy === true}
                  onClick={() => resolve(index, 'ours')}
                >
                  ours
                </button>
                <button
                  type="button"
                  className="stage"
                  data-testid="region-theirs"
                  disabled={busy === true}
                  onClick={() => resolve(index, 'theirs')}
                >
                  theirs
                </button>
                <button
                  type="button"
                  className="stage"
                  data-testid="region-both"
                  disabled={busy === true}
                  onClick={() => resolve(index, 'both')}
                >
                  both
                </button>
                <button
                  type="button"
                  className="stage"
                  data-testid="region-edit"
                  disabled={busy === true}
                  onClick={() => setEditing({ region: index, text: region.ours.join('\n') })}
                >
                  edit
                </button>
              </div>
              {editing?.region === index ? (
                <div className="region-edit">
                  <textarea
                    data-testid="region-text"
                    value={editing.text}
                    onChange={(event) =>
                      setEditing({ region: index, text: event.currentTarget.value })
                    }
                  />
                  <div className="region-edit-actions">
                    <button type="button" onClick={() => setEditing(null)}>
                      cancel
                    </button>
                    <button
                      type="button"
                      className="primary"
                      data-testid="region-save"
                      disabled={busy === true}
                      onClick={() => onResolve(index, 'custom', editing.text)}
                    >
                      resolve with this
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {sides === null ? (
        <p className="empty">loading…</p>
      ) : (
        <div className="conflict-sides">
          {SIDES.map((side) => (
            <div className="conflict-side" data-testid={`conflict-${side}`} key={side}>
              <h3>{side === 'base' ? 'the common ancestor' : side}</h3>
              <pre>{sides[side] === '' ? '(none)' : sides[side]}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
