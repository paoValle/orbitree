import { rmSync } from 'node:fs';

/** Nothing this run created outlives it, whether the specs remembered to clean up or not. */
export default function globalTeardown(): void {
  const root = process.env.ORBITREE_RUN_DIR;
  if (root === undefined || root === '') return;
  rmSync(root, { recursive: true, force: true });
}
