import { useEffect, useState } from 'react';

/**
 * A conflicted path, in the three versions git is holding for it.
 *
 * The common ancestor, what this branch has, and what the other one has: all three live in the
 * index as stages 1, 2 and 3 for as long as the conflict is unresolved, so the screen can show them
 * without touching the merge in progress. Reading is what this does; choosing a side is a row's own
 * button, and marking the path resolved is `git add`, which the same row offers.
 */
export interface ConflictPanelProps {
  readonly root: string | null;
  readonly path: string | null;
  readonly busy?: boolean;
  readonly onAbort: () => void;
}

const SIDES = ['base', 'ours', 'theirs'] as const;

export function ConflictPanel({
  root,
  path,
  busy,
  onAbort,
}: ConflictPanelProps): React.ReactElement {
  const [sides, setSides] = useState<Readonly<Record<string, string>> | null>(null);

  useEffect(() => {
    if (root === null || path === null) return;
    let cancelled = false;
    void Promise.all(
      SIDES.map(async (side) => {
        const result = await window.orbitree.readConflictSide({ path: root, file: path, side });
        // A missing stage is a state, not a failure: a file added on one side and modified on the
        // other has no common ancestor at all (`git show :1:path` exits 128), and the screen says
        // so rather than pretending the file was empty.
        return [side, result.ok ? result.value.content : null] as const;
      }),
    ).then((loaded) => {
      if (cancelled) return;
      setSides(Object.fromEntries(loaded.map(([side, text]) => [side, text ?? ''])));
    });
    return () => {
      cancelled = true;
    };
  }, [root, path]);

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
