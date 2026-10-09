# Changelog

Numbers quoted here come from a run of `make prove` on the date named, and from nothing else.

## 0.0.0 — 2026-10-09 — the ground floor

Phase P0: the foundation, and nothing above it.

**Core** (`@keplerk/core`) — no UI, no Electron, no network:

- one typed `GitCommand` union (22 operations) with an exhaustive `riskOf` and a pure `toArgv`;
- one executor: `spawn` with an argv array and `shell: false`, timeouts, redaction, a confirmation
  gate, and an environment built for a GUI (`GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`);
- total parsers for `status --porcelain=v2 -z` and `log -z --format`, keeping every raw record;
- a pure, deterministic commit-graph layout (lanes, edges, merge continuity).

**CLI** (`@keplerk/cli`) — `status`, `graph`, `refs`, `ops`, `run`, `doctor`, `schema`; `--json`
prints one object on stdout, exit codes 0–5 are a documented contract, and a destructive operation
needs `--confirm "<reason>"` or `--dry-run`. Runs straight from TypeScript source with no build.

**Desktop** (`@keplerk/desktop`) — an Electron 44 window that opens a repository, draws the commit
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
