# Roadmap

Each phase ends with an exit criterion that is a **command**, not a feeling. A phase is not
done when the code compiles; it is done when the command it names produces the output it
promises. Phases are ordered by what unblocks the next one, not by how interesting they are.

Status: **P0 in progress**, everything after it unstarted.

---

## P0 — The ground floor

The repository, the process, and the one vertical slice that proves the architecture.

- [x] MIT licence, contribution files, issue and PR templates, CI on Linux/macOS/Windows.
- [x] `packages/core`: the single guarded gateway to `git`, the status and log parsers, the
      graph layout, redaction, typed errors.
- [x] `packages/cli`: `status`, `graph`, `refs`, `diff`, `show`, `ops`, `run`, `doctor`, `schema` —
      all with `--json`.
- [x] `apps/desktop`: an Electron window that opens a repository, draws the graph on a canvas,
      lists the working tree, and has a quick-command bar with a confirmation sheet.
- [x] The harness: `make verify` (format, lint, types, invariants, tests), `make prove`,
      `make mutate`, `bin/check-invariants.sh`.
- [x] Eight invariants, each with a test that names it (`docs/INVARIANTS.md`).

**Exit**: `make verify` is green on three operating systems, and
`orbitree graph . --json` prints lanes and edges for a real repository.

---

## P1 — See

Make the repository legible. No mutation beyond staging yet.

- [ ] Repository list and recents, one window per repository, restoring the last selection.
- [ ] Load more history. The window says `300 of 2054` and there is no way to ask for the other 1754.
      The count that made the truncation visible is also the argument for a way to extend it.
- [x] The graph pane as its own component: virtualised rows, keyboard navigation, lane colours
      and badges for HEAD/branches/tags/remotes, `--all`.
- [ ] Per-branch filters in the graph pane.
- [x] Commit detail: message, author, date, changed files, unified diff, per-file diff. The data is
      already there (`readCommit` / `orbitree show`): message, body, `against` and the parsed patch.
      What is missing is the pane that draws it.
- [ ] Working tree: staged and unstaged sections, per-file diff, file-kind icons.
- [ ] Stash list (read-only), submodule badge (read-only), conflict markers visible.
- [ ] Empty, unborn, detached, mid-merge states each get a designed screen, not a fallback.

- [x] **Exit**, measured on one repository of 2053 commits and 79 refs built by
      `bin/make-big-repo.sh`: `orbitree graph . --json --limit 2000` returns 2000 of 2054 commits in
      0.3 s including Node's startup, and the window opens that same repository in 972 ms, renders 30
      of 2054 rows, and scrolls to the last commit in 38 ms. "Without dropping a frame" is taken to
      mean a row count bounded by the viewport and a bounded scroll cost, which is what was measured;
      no frame timing was taken, and saying otherwise would be inventing a number.

## P2 — Change

The working tree becomes editable, and the confirmation machinery gets its real workout.

- [ ] Stage, unstage, discard (per file and per hunk), amend, commit, commit-and-push.
- [ ] Branch create/switch/rename/delete, tag create/delete, checkout of a commit (detached).
- [ ] Merge, and the conflict screen: ours/theirs/both at the hunk level.
- [ ] Stash push/pop/apply/drop, with a diff preview.
- [ ] Undo: every change in the session is listed with the `git` command that reverses it.
- [ ] Every one of those is reachable through `orbitree run --op <op>`, with `--dry-run` first.

**Exit**: `orbitree run --op commit --message x --json` and the app's Commit button produce the
same commit object on the same input — asserted by a test, not by inspection.

## P3 — Sync

Remotes, credentials, and the errors that come with the network.

- [ ] Fetch (with progress), pull fast-forward-only, push, force-push-with-lease behind a
      confirmation, remote management.
- [ ] Credentials from the system helper: `git credential fill`, `gh auth token`, `glab auth
      token`, SSH agent. Tokens are never written to a config file of ours.
- [ ] Per-repository identity (name/email/signing key) with the effective value shown.
- [ ] A network failure shows what to do (SSH key, token scope, offline), not just stderr.

**Exit**: a real `git push` to a GitHub repository and to a self-hosted GitLab instance from
the app, each with the token coming from the system helper and never appearing in a log —
checked by a test that greps the session log for the token's shape.

## P4 — Quick commands

The requested centrepiece, finished.

- [ ] Commands are data: `quickCommands` in the user's config, each with `{ id, label, hint,
      command, danger }` validated by the same schema the IPC uses.
- [ ] A command can take arguments (a branch, a path) and a message, and can be run against a
      selection in the graph or the working tree.
- [ ] The confirmation sheet shows the exact `git` argv (from `--dry-run`) before asking for a
      reason.
- [ ] Command palettes: the same commands from a keyboard, and from the CLI by id.
- [ ] Sharing: a quick-command preset is a JSON file someone can commit to their dotfiles.

**Exit**: `orbitree run --op <op> --dry-run --json` and the GUI's confirmation sheet print the
same argv for the same button — asserted against the shipped preset list.

## P5 — Forges

Pull requests and merge requests, without becoming a forge client.

- [ ] One adapter interface: `listRequest`, `getRequest`, `createRequest`, `checksFor`, `auth`.
- [ ] GitHub (via the REST API, reusing `gh auth token` when present).
- [ ] GitLab, including self-hosted, via a configurable API base URL.
- [ ] A generic "git only" mode for anything else: no forge features, everything else works.
- [ ] CI status per commit in the graph, and per request in the request list.
- [ ] Recorded HTTP fixtures in the test suite, plus a live test against a containerised
      self-hosted forge, marked opt-in so CI stays reproducible.

**Exit**: `orbitree requests . --json` lists open requests for a GitHub repository and for a
self-hosted GitLab project, with the same schema.

## P6 — Agents

Make the machine-readable surface a first-class product, not a side door.

- [ ] `orbitree mcp` — an MCP server exposing every operation with the CLI's schemas, plus
      read-only resources for the graph and the working tree.
- [ ] `orbitree schema --json` publishes a versioned JSON Schema per command; the schema version
      is bumped by policy, and a test fails when `data` changes without a bump.
- [ ] `orbitree watch --json` — a line-delimited stream of repository state changes, so an agent
      can wait for a change instead of polling.
- [ ] A written contract for agents: what is safe to call without asking, what is not, and how
      to undo (`docs/AGENT-CLI.md`).
- [ ] Operational history in the app: every command an agent ran, with its argv and exit code.

**Exit**: an agent completes "find the commit that broke the test, revert it, verify" using only
`orbitree` in machine-readable mode, and the app shows what it did.

## P7 — Ship

Releases people can install and trust.

- [ ] electron-builder targets: macOS (arm64/x64, signed and notarised), Windows (NSIS, signed),
      Linux (AppImage + deb).
- [ ] Auto-update from the release artifacts, with a channel for pre-releases.
- [ ] A release workflow that refuses to publish unsigned artifacts, and records the sha256 of
      each one in the release notes.
- [ ] Crash and error reporting that is local: a log file the user can read and attach.
- [ ] Documentation site: getting started per platform, the CLI reference generated from the
      published schemas, the invariant list.
- [ ] SBOM and a dependency-update cadence that a bot keeps honest.

**Exit**: a fresh machine on each of the three operating systems installs the published artifact,
opens a repository, and `orbitree doctor` reports nothing to fix.

---

## Deliberately not on the roadmap

Anything in the `Later` and `Never` columns of `docs/PRODUCT.md`. If a phase grows one of those
items, the phase is wrong, not the product.

## How a phase gets a PR

1. One issue per bullet, opened before the work, with the exit criterion quoted in it.
2. A branch per issue, a test that fails without the change, `make verify` green.
3. One commit per coherent change; the body says what was measured.
4. Update this file in the same PR: a phase item is ticked only when its exit command has run.
