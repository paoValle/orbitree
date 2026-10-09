import { defineConfig } from '@playwright/test';

/**
 * The UI test drives the real Electron window, not a browser: there are no browser
 * projects here, and `_electron.launch` finds the Electron binary in the app's own
 * node_modules. One worker because a second window on the same machine only makes the
 * timing less honest.
 */
export default defineConfig({
  testDir: 'test/e2e',
  // Artifacts belong under the already-ignored `reports/`, so a run never leaves an
  // untracked directory beside the source.
  outputDir: 'reports/test-results',
  globalSetup: './test/e2e/global-setup.ts',
  reporter: [['list']],
  workers: 1,
  timeout: 60_000,
});
