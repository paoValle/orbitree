import { useEffect, useState } from 'react';
import type { CommitData } from '../shared/api.ts';
import { DiffView } from './DiffView.tsx';
import { CommitIcon } from './icons.tsx';

export interface CommitPanelProps {
  readonly root: string | null;
  readonly hash: string | null;
}

/**
 * The detail for the selected commit. The patch comes from `readCommit`, which chooses the
 * comparison from the commit's own parent count — a merge is read against its first parent —
 * so this component never decides what a diff is against; it only labels what it was given.
 */
export function CommitPanel({ root, hash }: CommitPanelProps): React.ReactElement {
  const [data, setData] = useState<CommitData | null>(null);
  const [fileIndex, setFileIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    setFileIndex(0);
    if (root === null || hash === null) return;
    let cancelled = false;
    void window.orbitree.readCommit(root, hash).then((result) => {
      if (cancelled) return;
      if (result.ok) setData(result.value);
      else setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [root, hash]);

  if (hash === null) {
    return (
      <div className="card">
        <h2>
          <CommitIcon size={13} />
          Commit
        </h2>
        <p className="empty">Select a commit in the graph.</p>
      </div>
    );
  }

  const file = data?.files[fileIndex] ?? null;

  return (
    <div className="card commit-panel" data-testid="commit-panel">
      <h2>
        <CommitIcon size={13} />
        Commit
      </h2>
      {data === null && error === null && <p className="empty">loading…</p>}
      {error !== null && <p className="empty">{error}</p>}
      {data !== null && (
        <>
          <div className="commit-subject" data-testid="commit-subject">
            {data.commit.subject}
          </div>
          <div className="commit-meta" data-testid="commit-meta">
            <code>{data.commit.hash}</code>
            <br />
            {data.commit.author.name} &lt;{data.commit.author.email}&gt;
            <br />
            {/* Unambiguous on purpose: `toLocaleString` renders 10/9/2026, which is October in
                one locale and September in another. A client that is used from a terminal beside
                it cannot afford a date that reads two ways. */}
            {new Date(data.commit.committedAt * 1000).toISOString().slice(0, 16).replace('T', ' ')}{' '}
            UTC
            {data.against !== 'parent' && <> · against {data.against}</>}
          </div>
          <ul className="file-list">
            {data.files.map((entry, index) => (
              <li key={entry.path}>
                <button
                  type="button"
                  data-testid="file-item"
                  data-path={entry.path}
                  className={index === fileIndex ? 'file selected' : 'file'}
                  onClick={() => setFileIndex(index)}
                >
                  <span className="fstatus">{entry.status}</span>
                  <span className="fpath">{entry.path}</span>
                </button>
              </li>
            ))}
            {data.files.length === 0 && <li className="empty">no changes</li>}
          </ul>
          {file !== null && <DiffView file={file} />}
        </>
      )}
    </div>
  );
}
