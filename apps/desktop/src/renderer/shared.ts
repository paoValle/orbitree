import type { QuickCommand, RunPayload } from '../shared/api.ts';

/** A destructive command waiting for the reason that will let it run. */
export interface Pending {
  readonly command: QuickCommand;
  readonly reason: string;
}

/** One line for the activity log: the command, its exit code, and the first thing it said. */
export function summarize(result: RunPayload): string {
  const headline = `git ${result.argv.join(' ')} → ${result.exitCode}`;
  const detail = (result.stderr || result.stdout).trim().split('\n').slice(0, 2).join(' · ');
  return detail === '' ? headline : `${headline} — ${detail}`;
}
