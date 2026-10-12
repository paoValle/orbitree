import { rmSync } from 'node:fs';

/** Nothing this run created outlives it, whether the specs remembered to clean up or not. */
export default function globalTeardown(): void {
  const root = process.env.ORBITREE_RUN_DIR;
  if (root === undefined || root === '') return;
  // Retried for the same reason: a process that has not quite exited can still be writing.
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
