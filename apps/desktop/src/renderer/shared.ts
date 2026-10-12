import type { QuickCommand, RunPayload } from '../shared/api.ts';

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
}

export function recordRun(result: RunPayload): RunRecord {
  return {
    id: crypto.randomUUID(),
    command: `git ${result.argv.join(' ')}`,
    exitCode: result.exitCode,
    detail: (result.stderr || result.stdout).trim().split('\n').slice(0, 2).join(' · '),
  };
}
