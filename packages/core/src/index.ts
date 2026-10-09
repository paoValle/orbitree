/**
 * `@orbitree/core` — everything the product knows about git, and nothing about pixels.
 *
 * The dependency rule that makes the invariants hold: this package may import `node:*`
 * (child processes, paths) and nothing else. No Electron, no React, no HTTP client.
 * The network is git's job, and the screen is somebody else's.
 */
export const APP_NAME = 'orbitree';

export * from './git/command.ts';
export * from './git/count.ts';
export * from './git/diff.ts';
export * from './git/exec.ts';
export * from './git/log.ts';
export * from './git/redact.ts';
export * from './git/status.ts';
export * from './graph/layout.ts';
export * from './repo.ts';
export const SCHEMA_VERSION = 1;
