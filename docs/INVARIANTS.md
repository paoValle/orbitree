# Invariants

An invariant here is not a principle in prose. It is a property the code is expected to have
that **breaks loudly** if someone violates it, and that has a test naming it with `[In]` in the
title. Two rules keep this file honest:

1. A claim without a test is deleted, or the test is written. `bin/check-invariants.sh` runs in
   `make verify` and fails in both directions: a claimed invariant with no test, and a tagged
   test with no claim.
2. A test that cannot fail is not a test. See *What is not allowed in the suite* at the end.

```
$ make verify-invariants
check-invariants: 8 invariants, each one tested at least once
```

## The list

| | Invariant | Enforced in | Test |
|---|---|---|---|
| **I1** | A destructive operation cannot run without an explicit, attributed confirmation | `riskOf`, `execute` | `command.test.ts` |
| **I2** | Git is never reached through a shell; arguments can never be read as flags | `toArgv`, `assertSafeRef` | `command.test.ts` |
| **I3** | The app and the CLI are the same program: one core, no second implementation | package boundaries | `cli.test.ts`, `boundaries.test.ts` |
| **I4** | The parsers are total: no exception, no silently dropped record | `parseStatus`, `parseLog` | `status.test.ts` |
| **I5** | What we read agrees with git's own plumbing, on real repositories | `findStatusMismatches` | `status.test.ts`, `layout.test.ts` |
| **I6** | The graph layout is a pure function of the DAG, and its invariants hold on random histories | `layoutGraph`, `layoutViolations` | `layout.test.ts`, `prove.test.ts` |
| **I7** | The core is offline and UI-free: the network is git's job, the screen is somebody else's | package boundaries | `boundaries.test.ts` |
| **I8** | A credential never leaves the process: redaction happens on the way in | `redact`, `execute` | `redact.test.ts` |

---

### I1 — Destructive means confirmed

**What it protects**: the user's uncommitted work, and the trust an agent needs in order to be
allowed near a repository at all.

**Enforced by**: `riskOf(cmd)` is an exhaustive `switch` over the command union with no
`default`, so an operation added without a risk does not compile. `execute` refuses anything
whose risk is `destructive` unless a `confirmation` is present, and refuses a confirmation whose
`reason` is blank. A confirmation is `{ confirmedBy, reason, at }` — not a boolean, because a
`true` from a UI bug is indistinguishable from a deliberate click.

**Guarded operations**: `reset-hard`, `clean`, `discard`, `push` with `force`,
`branch-delete` with `force`. Everything else is `read`, `local` or `remote`.

**Without it**: a code path with a forgotten guard deletes a working tree, and nothing in the
test suite notices.

**Deliberate exception**: `--dry-run` resolves the argv *before* the confirmation check. Its
purpose is to show what would be confirmed.

### I2 — No shell, no flag injection

**What it protects**: a filename is data, not code. `git` never sees a shell.

**Enforced by**: `spawn('git', argv, { shell: false })` is the only spawn in the codebase
(checked again by I3's structural test), so arguments cannot be word-split or expanded. Paths are
placed after `--` in `toArgv`, which is a pure function and therefore testable. Refs cannot be
quoted away, so `assertSafeRef` rejects a leading `-`, whitespace and control characters — and
nothing else, because `HEAD~1` and `main..feature` are revisions the product's own features need.

**Specific lines that are assertions, not intentions**: a forced push emits
`--force-with-lease` and never `--force`; `clean` emits `-fd` and never `-x`; `pull` emits
`--ff-only`.

**Without it**: a repository containing `$(rm -rf ~).txt` or `-n` decides what our argv means.

### I3 — One core, two front-ends

**What it protects**: the claim that anything the GUI can do, an agent can do — which stops
being true the moment a front-end grows its own git invocation.

**Enforced by**: `packages/core` is the only package that imports `node:child_process`, checked
by grepping the front-ends' sources. The CLI test asserts that `status --json` prints exactly
the object `readStatus()` returns, field for field. The desktop's IPC schema is asserted at
compile time to cover the core's command union.

**Without it**: two implementations drift, and the divergence shows up as "the button works and
the CLI does not" in a bug report six months later.

### I4 — Total parsers

**What it protects**: a repository state we have not seen yet degrades into a message, not a
crash and not a wrong picture.

**Enforced by**: both parsers return a discriminated result instead of throwing; every entry
keeps its `raw` record, so nothing is dropped; an unknown header is retained, an unknown record
type is an error; a rename owns the following record in `-z` mode, and the test checks the entry
count against an independent count of the records.

**Without it**: a git version that adds a status record makes the app show a working tree that
is missing a file.

### I5 — Agree with git, not with ourselves

**What it protects**: the difference between "our two halves agree" and "we are right".

**Enforced by**: the fixtures are built with the real `git` binary, and then the v2 parse is
compared against four independent sources — `--porcelain=v1` (a different format), `rev-parse`,
`symbolic-ref`, `ls-files --unmerged`, `ls-files --others`, and `rev-list --count --left-right`
for ahead/behind. A test that compared the parser against a hand-written string would only have
proved that the string was typed twice. These fixtures catch the two-alphabet problem
(v1 spells "unmodified" as a space, v2 as a dot) the first time they run.

**Without it**: a parser bug is confirmed by a fixture written from the same misunderstanding.

### I6 — The layout is a pure function of the DAG

**What it protects**: the picture. A missing line, a line from nowhere, a commit drawn twice.

**Enforced by**: `layoutGraph` takes commits and returns rows, edges and lanes — no canvas, no
font metrics, no DOM. Over a thousand random topologically-ordered DAGs (with merges, roots,
octopus merges and truncated windows) `layoutViolations` recomputes every property from the
output: each commit once, lanes in range and ascending, every edge matching `parents[i]`, every
edge landing on the parent's own lane, continuity (a line passing a row existed one row above),
and one edge per parent inside the window.

**Without it**: the headline feature is subtly wrong, and only a human looking at the wrong
picture catches it.

**This test earned its place on the first run**: it found that a merge's second parent was
recorded as leaving from the *new* lane instead of the child's lane, which draws a line that
starts in the middle of nowhere.

### I7 — The core is offline and UI-free

**What it protects**: the layering. The moment the core fetches a URL or imports React, it stops
being usable from a CLI, a server, or a test without a display.

**Enforced by**: a structural test over `packages/core/src` that fails on an import of
`node:http`, `node:https`, `node:net`, `node:tls`, `node:dgram`, on a `fetch(` call, on an import
of `electron` or `react`, and on an import from `apps/`.

**Without it**: "support forges" turns into HTTP inside the core, and the boundary is gone
without anyone deciding to remove it.

### I8 — Credentials do not leave the process

**What it protects**: a token in a log file, a screenshot of an error, or a bug report.

**Enforced by**: `redact` is applied to every `stdout` and `stderr` inside `execute`, before
anything downstream can print or store it, and to the message of `GitFailedError`. It removes
credentials from URLs, GitHub/GitLab token shapes, AWS key ids and bearer headers. The test
covers each shape and asserts that an ordinary message is untouched.

**Without it**: a failed push prints `https://user:ghp_…@host/…` in the UI and in `--json`.

---

## How the tests earn the right to be believed

**Fixtures are real repositories.** `makeFixtures()` creates seven of them with the real `git`
binary: an unborn repository, a clean one, one with every ordinary state at once (staged,
unstaged, renamed, deleted, untracked), one with a merge conflict left in place, one with a
merge history and a tag, one with filenames designed to break a shell-less argv (`-leading-dash`,
`$(touch pwned)`, spaces, quotes, non-ASCII), and one with a real remote so ahead/behind are not
zero. The fixtures deliberately do **not** use the product's own executor: a bug in argument
building would then produce a repository matching the buggy expectation.

**Property-based tests where the input space is large.** The layout, the argv builder and the
parser fuzzing run over generated input (fast-check), not over examples someone thought of.

**Cross-checks against an independent source.** Anywhere git can answer the same question two
ways, the test asks both (I5, the entry count in I4).

**Mutation testing.** `make mutate` runs Stryker over `packages/core`. Coverage tells you a line
ran; a mutation tells you a test noticed. The mutation score is a slow, nightly gate, not a
per-commit one.

**The suite is measured, not asserted.** `make prove` runs `packages/core/test/prove.test.ts`,
which builds the fixtures, lays out random histories and prints what it found. The README's
numbers come from that output, copied, and never from memory.

## What is not allowed in the suite

Rejected in review, every time:

- **Asserting the implementation instead of the behaviour.**
  `expect(toArgv(cmd)).toEqual(['add', '--', 'x'])` is fine because it pins a deliberate
  guarantee; `expect(riskOf(cmd)).toBe(RISK[cmd.op])` would just restate the code.
- **A fixture typed by hand to match the parser.** It proves the string was typed twice (I5).
- **`expect(x).toBeTruthy()` on a value the test just constructed.**
- **A snapshot of a large object**, because nobody reviews the diff, and every change is
  accepted with "update the snapshot".
- **A test for a constant.** `expect(MINIMUM_GIT_VERSION).toBe('2.43')` is there only to make an
  intentional version bump require a second look, which is a decision, not an assertion.
- **Coverage as a goal.** There is no percentage to reach; there is behaviour to pin.

A test that cannot fail is worse than a missing test: it inflates confidence, and the review
that lets it through sets the standard for the next one.
