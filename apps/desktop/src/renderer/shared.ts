import type { GitCommand, QuickCommand, RunPayload } from '../shared/api.ts';

/** A destructive command waiting for the reason that will let it run. */
export interface Pending {
  readonly command: QuickCommand;
  readonly reason: string;
}

/**
 * One run, kept as its parts rather than as a sentence.
 *
 * The point of the activity list is the product's own thesis: the window and the CLI run the same
 * program. A line that says `git stash push` and can be copied into a terminal is that thesis made
 * useful; the same text formatted into a sentence can only be read.
 */
export interface RunRecord {
  /** Stable across re-renders: an index would be reused when two runs share a command. */
  readonly id: string;
  /** `git` and its arguments, as the core built them. */
  readonly command: string;
  readonly exitCode: number;
  /** The first thing the command said, or an empty string. */
  readonly detail: string;
  /**
   * `git` and its arguments, as the command that puts the repository back.
   *
   * `null` when there is nothing to undo with: work that was never committed, or a decision such as
   * a force push. A record that offered a line anyway would be offering a command that fails.
   */
  readonly reverse: {
    readonly command: GitCommand;
    readonly argv: readonly string[];
    readonly risk: string;
  } | null;
}

export function recordRun(result: RunPayload): RunRecord {
  return {
    id: crypto.randomUUID(),
    command: `git ${result.argv.join(' ')}`,
    reverse: result.reverse,
    exitCode: result.exitCode,
    detail: (result.stderr || result.stdout).trim().split('\n').slice(0, 2).join(' · '),
  };
}
