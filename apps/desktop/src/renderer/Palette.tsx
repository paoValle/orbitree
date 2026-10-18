import { useEffect, useMemo, useRef, useState } from 'react';
import { availableCommands, type CommandContext, type AvailableCommand } from './commands.ts';
import type { GitCommand } from '../shared/api.ts';

/**
 * Every command the window can run, filtered by typing.
 *
 * The point of it is not a faster button: it is that a person does not have to remember *where* an
 * action lives — the bar, a row, a card — only that it exists. So it lists what the window can do right
 * now, from one registry, and runs it through the same guarded path a click takes: a destructive entry
 * opens the confirmation sheet, wherever it was asked for.
 *
 * The filter matches the label and the command it will run, because "reset" and "checkout --detach" are
 * both things somebody types.
 */
export interface PaletteProps {
  readonly context: CommandContext;
  readonly busy?: boolean;
  readonly onRun: (entry: AvailableCommand) => void;
  readonly onClose: () => void;
}

export function Palette({ context, busy, onRun, onClose }: PaletteProps): React.ReactElement {
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  // The field is the dialog's first control and the only one that takes text, so focus is what makes the
  // keyboard the way in. A ref rather than the `autoFocus` attribute, for the same reason the ask dialog
  // does it this way: the attribute is a hint to the browser, this is the focus going where it is meant.
  const field = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    field.current?.focus();
  }, []);

  const commands = useMemo(() => availableCommands(context), [context]);
  const needle = query.trim().toLowerCase();
  const matching = useMemo(
    () =>
      needle === ''
        ? commands
        : commands.filter((entry) =>
            `${entry.label} ${entry.hint} ${entry.group} ${entry.command.op}`
              .toLowerCase()
              .includes(needle),
          ),
    [commands, needle],
  );

  const run = (entry: AvailableCommand | undefined): void => {
    if (entry === undefined) return;
    onRun(entry);
  };

  return (
    <div className="modal-backdrop">
      <div
        className="modal palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-testid="palette"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setHighlighted((previous) => Math.min(previous + 1, matching.length - 1));
            return;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setHighlighted((previous) => Math.max(previous - 1, 0));
            return;
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            run(matching[highlighted]);
          }
        }}
      >
        <input
          className="palette-input"
          data-testid="palette-input"
          ref={field}
          value={query}
          placeholder="run a command…"
          aria-label="Filter commands"
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setHighlighted(0);
          }}
        />
        <ul className="palette-list" data-testid="palette-list">
          {matching.length === 0 ? (
            <li className="empty" data-testid="palette-none">
              no command matches
            </li>
          ) : (
            matching.map((entry, index) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className={index === highlighted ? 'palette-item on' : 'palette-item'}
                  data-testid="palette-item"
                  data-command-id={entry.id}
                  data-danger={entry.danger ? 'yes' : 'no'}
                  // The pointer and the keyboard share one highlight: hovering moves it, so Enter always
                  // runs what is under the pointer or under the arrow, never a third thing.
                  onMouseEnter={() => setHighlighted(index)}
                  onClick={() => run(entry)}
                  disabled={busy === true}
                >
                  <span className="palette-label">{entry.label}</span>
                  <span className="palette-hint">{describe(entry.command)}</span>
                  <span className="palette-group">{entry.group}</span>
                </button>
              </li>
            ))
          )}
        </ul>
        <p className="palette-foot">↑↓ to move · Enter to run · Esc to close</p>
      </div>
    </div>
  );
}

/**
 * The command in words, which is what a reader recognises: `reset --hard <sha>` says what will happen
 * more precisely than the label above it.
 */
function describe(command: GitCommand): string {
  switch (command.op) {
    case 'fetch':
      return command.remote === undefined ? 'fetch --prune' : `fetch --prune ${command.remote}`;
    case 'pull':
      return 'pull --ff-only';
    case 'push':
      return `push ${command.remote} ${command.branch}`;
    case 'stash-push':
      return 'stash push';
    case 'stash-pop':
      return 'stash pop';
    case 'clean':
      return 'clean -fd';
    case 'reset-hard':
      return 'reset --hard';
    case 'reset-soft':
      return 'reset --soft';
    case 'checkout':
      return command.detach === true ? 'checkout --detach' : `checkout ${command.ref}`;
    default:
      return command.op;
  }
}
