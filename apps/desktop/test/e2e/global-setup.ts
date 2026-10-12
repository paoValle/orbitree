import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `_electron.launch` runs `out/main/index.js`, so the window the tests see must be built
 * from the source under test. Building here rather than in a `pre` script keeps
 * `"e2e": "playwright test"` honest: the command that runs the tests is the one that
 * builds, in the same process, before the first window opens.
 *
 * This also owns the one directory every fixture of the run lives in. It is created here, in the
 * process that outlives the workers, and removed by the teardown: a worker killed mid-run cannot
 * clean up after itself, and forgetting used to leave twenty repositories behind per run.
 */
export default function globalSetup(): void {
  const appRoot = join(import.meta.dirname, '..', '..');
  process.env.ORBITREE_RUN_DIR = mkdtempSync(join(tmpdir(), 'orbitree-run-'));
  execFileSync(join(appRoot, 'node_modules', '.bin', 'electron-vite'), ['build'], {
    cwd: appRoot,
    stdio: 'inherit',
  });
}
