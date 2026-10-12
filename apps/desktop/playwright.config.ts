import { defineConfig } from '@playwright/test';

/**
 * The UI test drives the real Electron window, not a browser: there are no browser
 * projects here, and `_electron.launch` finds the Electron binary in the app's own
 * node_modules. One worker because a second window on the same machine only makes the
 * timing less honest.
 */
export default defineConfig({
  use: {
    // A test that fails while nobody is watching has to leave evidence, and a bare timeout
    // leaves none: one produced nothing at all and the failure had to be hunted for in the
    // app's own source.
    //
    // A screenshot on failure only, never a trace. `retain-on-failure` records every test and
    // keeps the failures, which took a 1.1-minute suite to 3.5 minutes and failed four tests
    // on the load it created. The artifact has to cost less than the failure it explains.
    screenshot: 'only-on-failure',
  },
  testDir: 'test/e2e',
  // Artifacts belong under the already-ignored `reports/`, so a run never leaves an
  // untracked directory beside the source.
  outputDir: 'reports/test-results',
  globalSetup: './test/e2e/global-setup.ts',
  reporter: [['list']],
  workers: 1,
  timeout: 60_000,
});
