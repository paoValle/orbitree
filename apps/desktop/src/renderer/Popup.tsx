import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_QUICK_COMMANDS, type QuickCommand, type RepoState } from '../shared/api.ts';
import { quickIcon } from './icons.tsx';
import { type Pending, summarize } from './shared.ts';

/**
 * The quick window: what is true about the repository right now, and the four or five
 * things a person reaches for most, in a panel that sits beside the cursor.
 *
 * It is deliberately the same renderer as the app: the panes, the commands and the
 * confirmation sheet are shared, so there is nothing here that can drift from the real
 * window. What is different is the size, and that the window closes when it loses focus.
 */
export function Popup(): React.ReactElement {
  const [path, setPath] = useState('');
  const [state, setState] = useState<RepoState | null>(null);
  const [hotkey, setHotkey] = useState<string | null>(null);
  const [log, setLog] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  // Focused when the sheet opens, through a ref: the `autoFocus` attribute would move a
  // screen reader's reading position without asking.
  const reasonInput = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (pending !== null) reasonInput.current?.focus();
  }, [pending]);

  /**
   * The repository the quick window is about is the one the app was last looking at — the
   * same one the main window reopens. It is read every time the window is shown and not once
   * at mount: the panel exists while the main window keeps working.
   */
  const readCurrent = useCallback((): void => {
    void (async () => {
      const remembered = await window.orbitree.readState();
      if (!remembered.ok) return;
      setHotkey(remembered.value.hotkey);
      const last = remembered.value.last;
      if (last === null) {
        setPath('');
        setState(null);
        return;
      }
      setPath(last);
      const status = await window.orbitree.status(last);
      if (status.ok) setState(status.value.state);
    })();
  }, []);

  useEffect(() => {
    readCurrent();
    return window.orbitree.onShown(() => readCurrent());
  }, [readCurrent]);

  const runCommand = useCallback(
    async (command: QuickCommand, reason?: string): Promise<void> => {
      if (path === '') return;
      setBusy(true);
      const result = await window.orbitree.run({
        path,
        command: command.command,
        ...(reason === undefined ? {} : { confirm: reason }),
      });
      setBusy(false);
      setPending(null);
      if (!result.ok) return;
      setLog((previous) => [summarize(result.value), ...previous].slice(0, 6));
      const status = await window.orbitree.status(path);
      if (status.ok) setState(status.value.state);
    },
    [path],
  );

  return (
    <div className="popup">
      <header className="popup-head">
        <span className="dot" />
        <strong>{path === '' ? 'no repository' : nameOf(path)}</strong>
        {state !== null && <span className="popup-branch">{describeHead(state)}</span>}
      </header>

      <div className="popup-commands">
        {DEFAULT_QUICK_COMMANDS.map((command) => {
          const Glyph = quickIcon(command.id);
          return (
            <button
              key={command.id}
              type="button"
              className={command.danger ? 'quick danger' : 'quick'}
              disabled={path === '' || busy}
              onClick={() => {
                if (command.danger) setPending({ command, reason: '' });
                else void runCommand(command);
              }}
            >
              {Glyph === null ? null : <Glyph />}
              <span>{command.label}</span>
            </button>
          );
        })}
      </div>

      {state !== null && (
        <p className="popup-summary">
          {state.entries.length === 0
            ? 'working tree clean'
            : `${state.entries.length} changed ${state.entries.length === 1 ? 'file' : 'files'}`}
          {state.pending !== null ? ` · ${state.pending} in progress` : ''}
        </p>
      )}

      {log.length > 0 && <pre className="popup-log">{log.join('\n')}</pre>}

      <footer className="popup-foot">
        <button type="button" onClick={() => void window.orbitree.showWindow()}>
          Open the window
        </button>
        <span className="muted">
          {hotkey === null ? 'no hotkey set' : hotkey}
          <button
            type="button"
            className="link"
            onClick={() => void window.orbitree.setHotkey('CommandOrControl+Alt+G')}
          >
            reset
          </button>
        </span>
      </footer>

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

function nameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

function describeHead(state: RepoState): string {
  if (state.head.kind === 'branch') return state.head.name;
  if (state.head.kind === 'unborn') return 'no commits yet';
  return `detached at ${state.head.oid.slice(0, 7)}`;
}
