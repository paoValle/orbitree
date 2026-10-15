import { defineConfig } from '@playwright/test';

/**
 * The frames the README's GIFs are made of.
 *
 * A configuration of its own rather than a tag inside the suite: `make e2e` must not run this, and
 * a demo is not a test — it asserts nothing the suite does not already assert. It drives the same
 * real window, with the same setup and teardown, so the pictures in the README come from this
 * repository rather than from a screen recording somebody made once.
 *
 * `bin/make-gifs.sh` runs it and turns the frames into the GIFs.
 */
export default defineConfig({
  testDir: 'test/demo',
  // Kept out of `reports/` proper, which belongs to the suite.
  outputDir: 'reports/demo-artifacts',
  globalSetup: './test/e2e/global-setup.ts',
  globalTeardown: './test/e2e/global-teardown.ts',
  reporter: [['list']],
  // One window at a time, exactly as the suite does it: a second window on the same machine only
  // makes the timing less honest.
  workers: 1,
  timeout: 120_000,
});
