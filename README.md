# keplerk

A local-first Git client: a desktop app for understanding a repository, and a CLI that does
everything the app does — because it *is* the app, without the window.

> **Status: pre-alpha (roadmap phase P0).** The foundation is in place — the guarded git layer,
> the parsers, the graph layout, the CLI, an Electron shell that draws the graph, and the test
> harness. Most of what the product will be is not written yet: see
> [docs/ROADMAP.md](docs/ROADMAP.md).

## What it is

- **A graph you can read.** Commits, lanes, merges and refs, laid out by a pure function with
  property-based tests behind it.
- **A working tree you can act on.** Stage, commit, branch, merge, push — with the quick-command
  bar as the primary surface, and a reason required before anything destructive runs.
- **A CLI an agent can drive.** `keplerk … --json` prints one object on stdout with stable exit
  codes, and goes through the same core as the app.
- **No account, no cloud, no telemetry.** MIT. Local-first. The forge is an integration, not a
  dependency.

## Quick start

Requires **Node ≥ 22.12** and **git ≥ 2.43** on `PATH`.

```bash
git clone https://github.com/paoValle/keplerk && cd keplerk
make setup            # pnpm install --frozen-lockfile
make verify           # format, lint, types, invariants, tests

./bin/keplerk doctor .            # is this machine able to run it?
./bin/keplerk status .            # the working tree
./bin/keplerk graph . --limit 20  # the graph, as text
./bin/keplerk graph . --json      # the graph, as data

make desktop          # the Electron app
```

The CLI runs straight from TypeScript source — there is no build step between an edit and a run.
That is why the core avoids `enum`, `namespace` and constructor parameter properties: they cannot
be type-stripped. `make cli` in CI runs the CLI from source so the mistake is caught where it is
made.

## What it can do today

| Command | What it returns |
|---|---|
| `keplerk status [path] --json` | `HEAD` (branch / detached / unborn, ahead and behind), staged, unstaged, renamed, unmerged and untracked entries |
| `keplerk graph [path] --json` | commits, rows with lanes, edges, and the refs on each commit |
| `keplerk refs [path] --json` | branches, tags and remote refs |
| `keplerk ops --json` | every operation, its risk level, and the argv it produces |
| `keplerk run --op <op> [--dry-run] [--confirm <reason>]` | the guarded way to change a repository |
| `keplerk doctor --json` | platform, node, git version, repository root |
| `keplerk schema` | the JSON envelope, the error kinds and the exit codes |

The desktop app opens a repository, draws the commit graph on a canvas, lists the working tree,
and runs quick commands with a confirmation sheet for the destructive ones.

See [docs/AGENT-CLI.md](docs/AGENT-CLI.md) for the full contract (exit codes, envelope, what is
safe to call without asking).

## The claims in this file are measured

`make prove` builds real repositories with the real `git` binary, lays out random histories and
prints what it found. Nothing in this README is a number somebody remembered.

```
$ make prove
[prove] git = 2.54.0                            (whatever is installed here)
[prove] repositories built with the real git binary = 7
[prove] of those, with changes to read = 3
[prove] working-tree entries parsed = 7
[prove] working-tree entry kinds covered = ordinary, renamed, unmerged, untracked
[prove] head kinds covered = branch, detached, unborn
[prove] disagreements with rev-parse/symbolic-ref/ls-files/porcelain-v1 = 0
[prove] random histories laid out = 500
[prove] commits placed = 9422
[prove] lanes used, in total = 1604
[prove] invariant violations = 0
[prove] refs refused as argument injection = 5
[prove] real revisions still accepted = 5
[prove] argv for a hostile path list = add -- -n a b.txt $(touch pwned)
[prove] secret samples that survive redaction = 0
```

"Disagreements = 0" is the interesting one: the porcelain v2 parser is compared, on every
fixture, against `git status --porcelain=v1`, `rev-parse`, `symbolic-ref`,
`ls-files --unmerged`, `ls-files --others` and `rev-list --count --left-right`. The expectations
do not come from the code under test.

## Trust is the feature

Eight invariants, each one enforced in code and named by a test. `make verify-invariants` fails if
a claim and a test ever stop matching:

| | Invariant |
|---|---|
| **I1** | A destructive operation cannot run without an explicit, attributed confirmation |
| **I2** | Git is never reached through a shell; an argument can never be read as a flag |
| **I3** | The app and the CLI are the same program: one core, no second implementation |
| **I4** | The parsers are total: no exception, no silently dropped record |
| **I5** | What we read agrees with git's own plumbing, on real repositories |
| **I6** | The graph layout is a pure function of the DAG, and holds on random histories |
| **I7** | The core is offline and UI-free |
| **I8** | A credential never leaves the process |

[docs/INVARIANTS.md](docs/INVARIANTS.md) explains what each one protects, how it is enforced, and
what breaks silently without it. It also lists the kinds of test this project refuses — a test
that cannot fail is worse than a missing one.

Two of them caught a real bug during P0: the layout invariant test found a merge line drawn from
a lane the commit was not in, and the cross-check test found the two-alphabet difference between
`--porcelain=v1` and `--porcelain=v2`.

## Documentation

| | |
|---|---|
| [docs/PRODUCT.md](docs/PRODUCT.md) | who it is for, the feature sift (must / should / later / never), risks |
| [docs/ROADMAP.md](docs/ROADMAP.md) | phases P0–P7, each with an exit criterion that is a command |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | layers, the decisions, the boundaries, the platform matrix |
| [docs/INVARIANTS.md](docs/INVARIANTS.md) | the invariants and the test strategy |
| [docs/AGENT-CLI.md](docs/AGENT-CLI.md) | the machine-readable contract, for scripts and agents |
| [docs/adr/](docs/adr/) | decisions with their trade-offs written down |

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). The short version: one issue per change, a test that
fails without it, `make verify` green, and a commit body that states what was measured.

The project is MIT ([LICENSE](LICENSE)) and intends to stay that way, with no proprietary tier
and no account.

## Requirements and the honest trade-off

Windows, macOS and Linux, built with Electron: one rendering engine for all three, at the price of
an installer of roughly 100 MB (measured in CI at packaging time, not estimated here). The
alternative — the system webview — was rejected because a commit graph must look the same on every
platform. Reasoning in [docs/adr/0001](docs/adr/0001-desktop-stack.md).

The `keplerk` name is a working name with existing projects of the same name; the decision is open
and the rename is one `grep`. See [docs/adr/0003](docs/adr/0003-name.md).
