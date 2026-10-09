# Notes for an AI agent working in this repository

`CONTRIBUTING.md` is the human version of this file and holds the reasoning. This one is the
checklist, in the order to do things.

## Before writing code

```bash
make setup          # pnpm install --frozen-lockfile
make verify         # must be green before you start, so a red result is yours
cat docs/INVARIANTS.md
```

Read `docs/ARCHITECTURE.md` if the change touches more than one package. It states which layer may
import what, and the rule is checked by a test, so breaking it fails `make verify` rather than a
review.

## The commands that matter

| | |
|---|---|
| `make verify` | the gate: format, lint, types, invariant traceability, tests |
| `make test` | the tests alone |
| `make prove` | re-measures the numbers the README claims |
| `make fmt` | writes formatting (Biome) |
| `make cli` | the CLI from source, for a manual check |
| `./bin/keplerk <cmd> --json` | the product's own machine-readable surface |

## Rules that fail the gate if broken

1. **A destructive operation needs a confirmation.** Add the operation to the `GitCommand` union
   in `packages/core/src/git/command.ts` and give it a risk in `riskOf`. The `switch` has no
   `default`, so forgetting is a compile error. Never add a bypass, never make `--dry-run` and
   "unconfirmed" the same thing.
2. **Never build a git argv outside `toArgv`.** No `spawn`/`execFile` outside
   `packages/core/src/git/exec.ts`; `packages/core/test/boundaries.test.ts` greps for it.
3. **No shell, ever.** `shell: true`, `exec`, and string concatenation into a command line are
   rejected.
4. **Parsers stay total.** `packages/core/src/git/*.ts` returns a result object, never throws, and
   keeps every raw record. Do not add a `throw` there.
5. **A new invariant needs both halves**: a `### In` heading in `docs/INVARIANTS.md` and a test
   whose title contains `[In]`. `./bin/check-invariants.sh` fails in either direction.
6. **Numbers in prose come from `make prove`.** If you write a number, run the command and copy
   the output. Never write a number you did not see printed.
7. **The layering.** `packages/core` imports `node:*` and nothing else. The front-ends do not
   import `node:child_process`. The renderer does not import `@keplerk/core` at runtime or any
   node builtin.
8. **No new dependency** without a paragraph in the pull request saying why the standard library
   or an existing dependency does not do.

## Do not write this kind of test

From `docs/INVARIANTS.md`, and rejected in review:

- an assertion that restates the implementation instead of pinning behaviour;
- a fixture typed by hand to match the parser (build it with the real `git` instead);
- `toBeTruthy()` on a value the test just constructed;
- a snapshot of a large object;
- a test whose only purpose is to raise a coverage percentage.

The preferred shape is a check against something that is not the product: the real `git` binary,
`--porcelain=v1`, `rev-parse`, `ls-files`, a randomly generated DAG, or a mutation.

## The shape of a change

One issue, one branch, one coherent commit. The commit subject is imperative and under ~72
characters; the body says what changed, why, and what was measured. Stage only the files the
change is about.

**A commit written by an agent carries `Co-authored-by: Claude <noreply@anthropic.com>` as the last
trailer.** GitHub resolves that address to the account `github.com/claude`, so the co-authorship is
real in the history rather than text. Do not use `claude-code@anthropic.com`: that address belongs
to an unrelated account, and the commit would be misattributed to a stranger.

Before opening a pull request:

```bash
make verify
./bin/keplerk status . --json | head -40   # if the change touches what the CLI prints
```

If the change closes a phase item in `docs/ROADMAP.md`, tick the box in the same pull request, and
only after its exit command has actually run.

## Status of the project

Phase P0 is complete: core, CLI, an Electron shell, the harness. P1 (the graph pane as a real
component) is the next thing. Do not start a later phase because it looks interesting — the
roadmap order exists because each phase unblocks the next.

## Where the interesting bugs were found

Worth knowing, because it is where the next one probably is:

- `packages/core/src/graph/layout.ts` — a merge's second parent recorded as leaving from the wrong
  lane, found by the random-DAG invariant test.
- `packages/core/test/support/crosscheck.ts` — `--porcelain=v1` spells "unmodified" as a space and
  v2 as a dot, found by the cross-check test.
- `packages/core/src/git/command.ts` — a guard that was too strict (`a~1`) would have broken
  `reset-hard --rev HEAD~1`; the test now asserts both directions, refused and accepted.

Layout and argv are where the subtle mistakes live. Test both directions there.
