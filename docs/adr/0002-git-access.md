# 2. Git access: the installed binary, behind one guarded gateway

- **Status**: accepted
- **Date**: 2026-10-09

## Context

A Git client can reach git three ways: link `libgit2` (`nodegit`-class bindings), re-implement the
parts it needs, or run the `git` binary. It also has to decide how many places in the code are
allowed to build a `git` argument list.

## Decision

Run the installed `git`, and route every invocation through one typed command union in
`packages/core/src/git/command.ts`. Minimum accepted version: **2.43**, checked by
`orbitree doctor`.

```ts
{ op: 'push', remote: 'origin', branch: 'main', force: true }
// → ['push', 'origin', 'main', '--force-with-lease']   (never `--force`)
```

## Consequences

**Bought**:

- git's semantics, because it is git: hooks, attributes, filters, credential helpers, GPG
  signing, merge strategies, `rerere`, the user's own configuration.
- No native addons, so no rebuild per Node/Electron ABI, and no "the module was compiled against a
  different version" class of issue report.
- The dangerous decisions are one pure function: paths after `--`, `clean -fd` and never `-fdx`,
  a forced push always `--force-with-lease`, a pull always `--ff-only`. Those are assertions in a
  test, not habits in a review.
- One place to add a timeout, an environment, and a redaction pass — each of which was needed
  immediately (`GIT_TERMINAL_PROMPT=0` so a GUI never hangs on a password prompt it cannot show;
  `GIT_OPTIONAL_LOCKS=0` so a background refresh does not take the index lock from the user's own
  terminal).

**Accepted cost**: `git` must be on `PATH`. A user without it gets a message naming the problem
and the download page (`GitNotFoundError`), and `orbitree doctor` reports it before anything else.
**Bundling a git binary for Windows is a packaging decision for a later release** (dugite, or Git
for Windows minus the installer), to be made with a measured artifact size, not by default.

**Rejected**: `isomorphic-git` (a re-implementation, so a second opinion about what a repository
is, and missing the features this product is for), `nodegit` (native-addon maintenance), and
shelling out from feature code (the first thing to drift, and the reason an operation can silently
lose its guards).
