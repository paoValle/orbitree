import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_QUICK_COMMANDS,
  type GraphData,
  type QuickCommand,
  type RepoState,
  type RunPayload,
} from '../shared/api.ts';
import { CommitPanel } from './CommitPanel.tsx';
import { GraphPane } from './GraphPane.tsx';
import { WorkingTreePanel } from './WorkingTreePanel.tsx';

interface Pending {
  readonly command: QuickCommand;
  readonly reason: string;
}

/**
 * The graph is read one window at a time: a 200,000-commit repository must not cross IPC
 * as a single object. The window is only honest because the header says "300 of 2053",
 * so a reader can tell a truncated list from the whole history.
 */
const GRAPH_LIMIT = 300;

export function App(): React.ReactElement {
  const [path, setPath] = useState('');
  const [root, setRoot] = useState<string | null>(null);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [status, setStatus] = useState<RepoState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // `*` reads every ref; anything else names the history to read instead.
  const [filter, setFilter] = useState('*');
  // The window, in commits. `Load more` raises it by `GRAPH_LIMIT` and reads again.
  const [limit, setLimit] = useState(GRAPH_LIMIT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<readonly string[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  // The confirmation sheet takes focus when it opens. Done with a ref rather than the
  // `autoFocus` attribute, which steals focus from a screen reader's reading position.
  const reasonInput = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (pending !== null) reasonInput.current?.focus();
  }, [pending]);

  const refresh = useCallback(
    async (target: string, selection: string, requested: number): Promise<GraphData | null> => {
      setBusy(true);
      setError(null);
      const [graphResult, statusResult] = await Promise.all([
        window.orbitree.graph(
          target,
          selection === '*'
            ? { limit: requested, all: true }
            : { limit: requested, rev: selection },
        ),
        window.orbitree.status(target),
      ]);
      if (!graphResult.ok) setError(graphResult.error);
      else {
        setGraph(graphResult.value.data);
        setRoot(graphResult.value.root);
        setPath(graphResult.value.root);
      }
      if (statusResult.ok) setStatus(statusResult.value.state);
      setBusy(false);
      return graphResult.ok ? graphResult.value.data : null;
    },
    [],
  );

  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get('repo');
    if (initial !== null) void refresh(initial, '*', GRAPH_LIMIT);
  }, [refresh]);

  const pick = async (): Promise<void> => {
    const chosen = await window.orbitree.pickDirectory();
    if (chosen === null) return;
    setFilter('*');
    setLimit(GRAPH_LIMIT);
    setSelected(null);
    void refresh(chosen, '*', GRAPH_LIMIT);
  };

  const runCommand = useCallback(
    async (command: QuickCommand, reason?: string) => {
      if (root === null) return;
      setBusy(true);
      const result = await window.orbitree.run({
        path: root,
        command: command.command,
        ...(reason === undefined ? {} : { confirm: reason }),
      });
      setBusy(false);
      setPending(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setLog((previous) => [summarize(result.value), ...previous].slice(0, 8));
      await refresh(root, filter, limit);
    },
    [root, filter, limit, refresh],
  );

  const changeFilter = useCallback(
    async (selection: string): Promise<void> => {
      if (root === null) return;
      setFilter(selection);
      setLimit(GRAPH_LIMIT);
      // A different history has different commits: put the reader at its top.
      setSelected(null);
      const data = await refresh(root, selection, GRAPH_LIMIT);
      setSelected(data?.commits[0]?.hash ?? null);
    },
    [root, refresh],
  );

  const loadMore = useCallback((): void => {
    if (root === null) return;
    const next = limit + GRAPH_LIMIT;
    setLimit(next);
    // The selected hash is untouched: the larger window still contains it.
    void refresh(root, filter, next);
  }, [root, filter, limit, refresh]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          orbitree
        </div>
        <input
          className="path"
          value={path}
          placeholder="/path/to/a/repository"
          onChange={(event) => setPath(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && path !== '') {
              setFilter('*');
              setLimit(GRAPH_LIMIT);
              setSelected(null);
              void refresh(path, '*', GRAPH_LIMIT);
            }
          }}
        />
        <button type="button" onClick={() => void pick()}>
          Browse
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => {
            setFilter('*');
            setLimit(GRAPH_LIMIT);
            setSelected(null);
            void refresh(path, '*', GRAPH_LIMIT);
          }}
          disabled={path === '' || busy}
        >
          Open
        </button>
      </header>

      {root !== null && (
        <div className="quickbar">
          {DEFAULT_QUICK_COMMANDS.map((command) => (
            <button
              key={command.id}
              type="button"
              title={command.hint}
              className={command.danger ? 'quick danger' : 'quick'}
              disabled={busy}
              onClick={() => {
                if (command.danger) setPending({ command, reason: '' });
                else void runCommand(command);
              }}
            >
              {command.label}
            </button>
          ))}
          <span className="spacer" />
          <button
            type="button"
            className="quick"
            onClick={() => void refresh(root, filter, limit)}
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

      <main className="panes">
        <section className="graph-pane">
          {graph === null ? (
            <p className="empty">Open a repository to see its graph.</p>
          ) : (
            <GraphPane
              graph={graph}
              selected={selected}
              onSelect={setSelected}
              filter={filter}
              onFilterChange={(value) => void changeFilter(value)}
              pageSize={GRAPH_LIMIT}
              onLoadMore={loadMore}
            />
          )}
        </section>

        <aside className="side">
          <CommitPanel root={root} hash={selected} />

          <WorkingTreePanel
            root={root}
            state={status}
            busy={busy}
            onStage={(entryPath) =>
              void runCommand({
                id: 'stage',
                label: 'Stage',
                hint: '',
                danger: false,
                command: { op: 'add', paths: [entryPath] },
              })
            }
          />

          <div className="card">
            <h2>Activity</h2>
            {log.length === 0 ? (
              <p className="empty">nothing run yet</p>
            ) : (
              <pre>{log.join('\n')}</pre>
            )}
          </div>
        </aside>
      </main>

      {pending !== null && (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true">
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
    </div>
  );
}

function summarize(result: RunPayload): string {
  const headline = `git ${result.argv.join(' ')} → ${result.exitCode}`;
  const detail = (result.stderr || result.stdout).trim().split('\n').slice(0, 2).join(' · ');
  return detail === '' ? headline : `${headline} — ${detail}`;
}
