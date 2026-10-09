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

interface Pending {
  readonly command: QuickCommand;
  readonly reason: string;
}

export function App(): React.ReactElement {
  const [path, setPath] = useState('');
  const [root, setRoot] = useState<string | null>(null);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [status, setStatus] = useState<RepoState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
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

  const refresh = useCallback(async (target: string) => {
    setBusy(true);
    setError(null);
    const [graphResult, statusResult] = await Promise.all([
      window.orbitree.graph(target, { limit: 300, all: true }),
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
  }, []);

  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get('repo');
    if (initial !== null) void refresh(initial);
  }, [refresh]);

  const pick = async (): Promise<void> => {
    const chosen = await window.orbitree.pickDirectory();
    if (chosen !== null) void refresh(chosen);
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
      await refresh(root);
    },
    [root, refresh],
  );

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
            if (event.key === 'Enter' && path !== '') void refresh(path);
          }}
        />
        <button type="button" onClick={() => void pick()}>
          Browse
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => void refresh(path)}
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
            onClick={() => void refresh(root)}
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
            <GraphPane graph={graph} selected={selected} onSelect={setSelected} />
          )}
        </section>

        <aside className="side">
          <CommitPanel root={root} hash={selected} />

          <div className="card">
            <h2>Working tree</h2>
            {status === null ? (
              <p className="empty">nothing loaded</p>
            ) : (
              <>
                <p className="headline">{describeHead(status)}</p>
                <ul className="entries">
                  {status.entries.map((entry) => (
                    <li key={`${entry.kind}:${entry.path}`}>
                      <span className={`code ${entry.kind}`}>{entryCode(entry)}</span>
                      <span className="ename">{entry.path}</span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void runCommand({
                            id: 'stage',
                            label: 'Stage',
                            hint: '',
                            danger: false,
                            command: { op: 'add', paths: [entry.path] },
                          })
                        }
                      >
                        stage
                      </button>
                    </li>
                  ))}
                  {status.entries.length === 0 && <li className="empty">clean</li>}
                </ul>
              </>
            )}
          </div>

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

function entryCode(entry: RepoState['entries'][number]): string {
  switch (entry.kind) {
    case 'untracked':
      return '??';
    case 'ignored':
      return '!!';
    case 'unmerged':
      return 'UU';
    default:
      return `${entry.index === 'unmodified' ? '.' : codeLetter(entry.index)}${entry.worktree === 'unmodified' ? '.' : codeLetter(entry.worktree)}`;
  }
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

function summarize(result: RunPayload): string {
  const headline = `git ${result.argv.join(' ')} → ${result.exitCode}`;
  const detail = (result.stderr || result.stdout).trim().split('\n').slice(0, 2).join(' · ');
  return detail === '' ? headline : `${headline} — ${detail}`;
}
