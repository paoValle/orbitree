# Changelog

Numbers quoted here come from a run of `make prove` on the date named, and from nothing else.

## Unreleased

**A repository that has gone is a place, and the app stops reopening it.** When a remembered
directory no longer exists, the window shows a state screen — what is true, and what to do next —
instead of a banner about a process status, and it clears the path from what it would reopen by
itself. The path stays in the recents list, because a volume that is not mounted yet has not gone
for good. The core named the condition (`PathNotFoundError`) rather than folding it into a bad
argument, which is what lets a caller tell "install git" from "that repository is not there".

**And two windows could lose the state file.** The window and the popup both react to the same
event, both read-modify-write the same JSON file, and a write that interleaves can be read back as
corrupt — which is, by design, the default. The symptom was `recents` coming back empty. Writes are
serialised through one queue and land through `rename`, so a reader sees the old file or the new one
and never half of either.

**The app can commit, and the CLI's commit is the same commit.** The working tree pane has a
message box, an amend checkbox and a Commit button, and a staged row can be unstaged. The button
says why it is disabled instead of only being disabled, and a rejected commit keeps the message,
because losing what was typed is what makes a person stop using a window. An amend with an empty
message emits `git commit --amend --no-edit`: plain `--amend` opens an editor and would wait
forever in a process that has no terminal. The parity this phase's exit criterion asks for is
asserted rather than inspected — two identical repositories, one committed through the window and
one through `orbitree run --op commit`, compared on the tree, the subject and the author that git
itself reports, with the timestamp left out because it differs by construction.

Phase P1 begins with the two panes that make a repository legible: the graph and a commit.

**The graph pane is a component now.** `GraphPane` owns the scroll container, the canvas and the
rows. Only the visible window plus four rows of overscan exist in the DOM and are drawn on the
canvas, which is positioned at the window's first row, and the edges are filtered to those that
intersect it. Arrow keys move the selection one commit, Home and End go to the ends, and the
selected row is scrolled back into view by arithmetic. The selection is marked by a
`commit-row-selected` element inside the row, so selecting a commit does not change the number of
rows rendered.

**The commit panel draws what `readCommit` already returned.** Selecting a commit shows the hash,
author, date and — when the patch is not against the single parent — the `against` label (`root` or
`first-parent`), so a merge's one honest diff is labelled honestly. The changed files are a list,
the first is selected on load, and `DiffView` renders its hunks with a `+`/`-`/space gutter and a
background per line kind. The process boundary is one new channel, `commit:read`, with a zod-parsed
`{ path, rev }`.

**The window is what proves it.** `make e2e` builds the app and drives the real Electron window
through Playwright: it opens a repository named on the command line (`--repo=<path>`), checks the
four-commit fixture's count, merge and file list, navigates with the keyboard, and screenshots the
populated window to `reports/app.png`. A second spec builds sixty commits and asserts that fewer
than all of them are rendered and that the rendered hashes change after a scroll — windowing, not
hiding.

**The window says what it is.** `readGraph` counts the history with `git rev-list --count` in the
same `Promise.all` as the log and the refs, so `GraphData` carries `total` and a computed
`truncated` (`commits.length < total`) instead of leaving a caller to infer them. `orbitree graph
--json` publishes both, and the human output opens with the window: `2000 of 2053 commits · 2
lanes`, or `14 commits · 1 lane` when nothing was cut. The desktop pane reads the same two fields,
so its `graph-count` says `300 of 2053 commits` rather than claiming 300 is all there is. A window
that does not say it is a window is a lie, not a limit.

## 0.0.0 — 2026-10-09 — the ground floor

Phase P0: the foundation, and nothing above it.

**A patch, as data.** `orbitree diff [path] [--rev <rev>] [--json]` returns the changes as files and
hunks (`path`, `oldPath`, `status`, `binary`, and per hunk the header, the starts and the lines with
their kind), each keeping the raw text git printed. Without `--json` it prints the patch, which is
what a terminal wants. Every path and status is cross-checked against git's own `--name-status`,
`--numstat` and `--name-only -z` output, on a friendly fixture and on one with filenames that force
git to quote them.

**A commit, as data.** `orbitree show [path] [--rev <rev>] [--json]` answers "what did this commit
change": the commit metadata (hash, parents, author, authored and committed time, subject and
message body) plus the patch, in exactly the shape `diff` returns. A merge is shown as one diff
against its first parent — plain `git show` prints nothing for a merge, and `-m` alone prints one
diff per parent, so the command picks the honest answer — and `against` (`root`, `parent` or
`first-parent`) is derived from the commit's own parent count so the UI can label the patch
truthfully. Every field is compared against `git log -1 --format=%H/%P/%an/%ae/%at/%ct/%B` and every
file and line count against `git show --name-status`/`--numstat`, on a merge, an ordinary commit
and a root commit.

**Core** (`@orbitree/core`) — no UI, no Electron, no network:

- one typed `GitCommand` union (22 operations) with an exhaustive `riskOf` and a pure `toArgv`;
- one executor: `spawn` with an argv array and `shell: false`, timeouts, redaction, a confirmation
  gate, and an environment built for a GUI (`GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`);
- total parsers for `status --porcelain=v2 -z` and `log -z --format`, keeping every raw record;
- a pure, deterministic commit-graph layout (lanes, edges, merge continuity).

**CLI** (`@orbitree/cli`) — `status`, `graph`, `refs`, `ops`, `run`, `doctor`, `schema`; `--json`
prints one object on stdout, exit codes 0–5 are a documented contract, and a destructive operation
needs `--confirm "<reason>"` or `--dry-run`. Runs straight from TypeScript source with no build.

**Desktop** (`@orbitree/desktop`) — an Electron 44 window that opens a repository, draws the commit
graph on a canvas with lane colours and ref badges, lists the working tree, and runs quick commands
from a bar with a confirmation sheet that demands a reason.

**Harness** — `make verify`, `make prove`, `make mutate`, `bin/check-invariants.sh` (traceability in
both directions), CI on Linux, macOS and Windows.

**Measured on 2026-10-09** (`make prove`, git 2.54.0, darwin/arm64, node 22.23.3):

| | |
|---|---|
| repositories built with the real git binary | 7 |
| working-tree entry kinds covered | ordinary, renamed, unmerged, untracked |
| head kinds covered | branch, detached, unborn |
| disagreements with `rev-parse`/`symbolic-ref`/`ls-files`/`--porcelain=v1` | 0 |
| random histories laid out | 500 |
| commits placed / lanes used | 9422 / 1604 |
| lint, layout and invariants violations | 0 |
| refs refused as argument injection | 5 |
| real revisions accepted | 5 |
| secret samples that survive redaction | 0 |

**Found by the harness while it was being written**, which is the point of building it first:

- the layout gave a merge's second parent the wrong `from` lane, drawing a line that began in an
  empty lane — found by the random-DAG invariant test;
- `--porcelain=v1` writes "unmodified" as a space and v2 as a dot, so a status comparison that
  looked correct was comparing two alphabets — found by the cross-check test;
- the ref guard was too strict: it would have refused `HEAD~1`, breaking `reset-hard` — the test now
  asserts the refused and the accepted lists.
