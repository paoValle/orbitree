import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * `_electron.launch` runs `out/main/index.js`, so the window the tests see must be built
 * from the source under test. Building here rather than in a `pre` script keeps
 * `"e2e": "playwright test"` honest: the command that runs the tests is the one that
 * builds, in the same process, before the first window opens.
 */
export default function globalSetup(): void {
  const appRoot = join(import.meta.dirname, '..', '..');
  execFileSync(join(appRoot, 'node_modules', '.bin', 'electron-vite'), ['build'], {
    cwd: appRoot,
    stdio: 'inherit',
  });
}
