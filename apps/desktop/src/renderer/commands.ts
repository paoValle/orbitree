import type { GitCommand, QuickCommand } from '../shared/api.ts';

/**
 * Every command this window can run, as data in one place.
 *
 * The quick bar, the command palette and (later) the keybindings all read this list rather than each
 * keeping its own: a command added here appears in both surfaces, and one removed disappears from both.
 * That is the whole reason the registry exists — two lists that describe the same actions are two lists
 * that drift, and the drift shows up as "the button works and the palette does not".
 *
 * A command is a **guarded operation** and nothing else: everything here goes through the same
 * `runGuarded` path as a click, so a destructive entry opens the confirmation sheet whichever surface
 * asked for it. Commands that need a value the registry cannot invent — a branch name, a tag name — are
 * not here; they open a dialog, which is a different kind of entry.
 */
export interface CommandContext {
  /** The commit selected in the graph, or `null`. */
  readonly selected: string | null;
}

interface Common {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly group: 'remote' | 'working tree' | 'commit';
  /** Destructive commands ask for a reason before they are allowed to run. */
  readonly danger: boolean;
}

/**
 * `quick` is the discriminator, and it does two jobs: it says whether the bar has room for this one,
 * and it says whether the command depends on the window's state. The bar's commands are about the
 * repository as a whole; everything else needs something selected.
 */
export type Command =
  | (Common & { readonly quick: true; readonly command: GitCommand })
  | (Common & {
      readonly quick: false;
      readonly command: (context: CommandContext) => GitCommand | null;
    });

export const COMMANDS: readonly Command[] = [
  {
    id: 'fetch',
    label: 'Fetch',
    hint: 'fetch --prune',
    group: 'remote',
    danger: false,
    quick: true,
    command: { op: 'fetch' },
  },
  {
    id: 'pull',
    label: 'Pull',
    hint: 'pull --ff-only',
    group: 'remote',
    danger: false,
    quick: true,
    command: { op: 'pull' },
  },
  {
    id: 'push',
    label: 'Push',
    hint: 'push the current branch',
    group: 'remote',
    danger: false,
    quick: true,
    command: { op: 'push', remote: 'origin', branch: 'HEAD' },
  },
  {
    id: 'stash',
    label: 'Stash',
    hint: 'stash push',
    group: 'working tree',
    danger: false,
    quick: true,
    command: { op: 'stash-push' },
  },
  {
    id: 'pop',
    label: 'Unstash',
    hint: 'stash pop',
    group: 'working tree',
    danger: false,
    quick: true,
    command: { op: 'stash-pop' },
  },
  {
    id: 'clean',
    label: 'Clean untracked files',
    hint: 'clean -fd',
    group: 'working tree',
    danger: true,
    quick: true,
    command: { op: 'clean' },
  },
  {
    id: 'reset-hard',
    label: 'Discard every uncommitted change',
    hint: 'reset --hard HEAD',
    group: 'working tree',
    danger: true,
    quick: true,
    command: { op: 'reset-hard', rev: 'HEAD' },
  },
  {
    id: 'checkout-detached',
    label: 'Check out the selected commit',
    hint: 'checkout --detach <sha>',
    group: 'commit',
    danger: false,
    quick: false,
    command: (context) =>
      context.selected === null ? null : { op: 'checkout', ref: context.selected, detach: true },
  },
  {
    id: 'reset-soft-selected',
    label: 'Move the branch here, keeping the work staged',
    hint: 'reset --soft <sha>',
    group: 'commit',
    danger: false,
    quick: false,
    command: (context) =>
      context.selected === null ? null : { op: 'reset-soft', rev: context.selected },
  },
  {
    id: 'reset-hard-selected',
    label: 'Reset --hard to the selected commit',
    hint: 'reset --hard <sha>',
    group: 'commit',
    danger: true,
    quick: false,
    command: (context) =>
      context.selected === null ? null : { op: 'reset-hard', rev: context.selected },
  },
];

/**
 * The buttons of the quick bar: the entries with room in the bar, in the order they are written above.
 *
 * The cast is the discriminator doing its job — `quick: true` means `command` is a command and not a
 * function of the context, which is what the bar needs.
 */
export function quickCommands(): readonly QuickCommand[] {
  return COMMANDS.filter((entry) => entry.quick).map((entry) => ({
    id: entry.id,
    label: entry.label,
    hint: entry.hint,
    danger: entry.danger,
    command: entry.command as GitCommand,
  }));
}

/** What the palette shows: every command that applies to the window as it is now. */
export interface AvailableCommand {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly group: string;
  readonly danger: boolean;
  readonly command: GitCommand;
}

/**
 * What the palette shows: every command that applies to the window as it is now.
 *
 * The user's own buttons come first when they have written any, because those are the commands they
 * chose to have within reach; the contextual entries follow, since a command about the selected commit
 * is not something a config file can be about. Both are the same shape, which is the point of the
 * registry: a button from a file and a button from this list are indistinguishable to the palette.
 */
export function availableCommands(
  context: CommandContext,
  configured: readonly QuickCommand[] | null = null,
): readonly AvailableCommand[] {
  const available: AvailableCommand[] = [];
  for (const entry of configured ?? []) {
    available.push({
      id: entry.id,
      label: entry.label,
      hint: entry.hint,
      group: 'yours',
      danger: entry.danger,
      command: entry.command,
    });
  }
  for (const entry of COMMANDS) {
    // With a file of their own, the bar's commands are theirs: the shipped ones that are also buttons
    // would be a second copy of the same thing under a different name.
    if (configured !== null && entry.quick) continue;
    const command = entry.quick ? entry.command : entry.command(context);
    if (command === null) continue;
    available.push({
      id: entry.id,
      label: entry.label,
      hint: entry.hint,
      group: entry.group,
      danger: entry.danger,
      command,
    });
  }
  return available;
}
