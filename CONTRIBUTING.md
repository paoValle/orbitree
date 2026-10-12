# Contributing

Thanks for looking. This document is short on purpose: the rules are few and they are enforced by
commands.

## Where a change goes

`next` is the development branch and the default one: branch from it, open a pull request against
it, and it merges there. `main` holds releases only, and receives a pull request from `next` when
something is released. Both branches are protected: no direct pushes, and an approval from the
maintainer is required before either merges. Name the branch for its change (`feat/`, `fix/`,
`test/`, `docs/`, `chore/`, `release/`), one change per branch.

## The one command

```bash
make setup     # pnpm install --frozen-lockfile
make verify    # format, lint, types, invariants, tests — exactly what CI runs
```

`make verify` must be green before a pull request. `make help` lists everything else.

## What a good change looks like

1. **An issue first**, one per change, saying what is wrong or missing and how it will be
   verified. Small is good: a 40-line diff that closes an issue beats a refactor nobody asked for.
2. **A test that fails without the change.** Run it before the fix and watch it go red; paste
   nothing, just know it. If the change cannot be tested, say so in the issue and explain why
   before writing code.
3. **The smallest coherent diff.** Reuse what is already here: the command union, the parsers, the
   layout, the test support helpers. A new dependency needs a paragraph in the pull request saying
   why the standard library or an existing dependency will not do.
4. **The repo's own style.** Biome formats and lints; run `make fmt`. Commits are imperative
   ("reject a ref git would read as a flag"), the body says what was measured.
5. **An agent-written commit says so.** A commit whose code was written by an AI agent ends with
   `Co-authored-by: Claude <noreply@anthropic.com>`. That address resolves to `github.com/claude`,
   so the trailer is a real co-author and not decoration; `claude-code@anthropic.com` is a
   different, unrelated account and must not be used.
6. **The documentation moves with the code.** A phase item in `docs/ROADMAP.md` is ticked only
   when its exit command has run here; a new invariant goes into `docs/INVARIANTS.md` **and** gets
   a test tagged `[In]`, or `make verify` fails.

## Where things go

| Change | Where |
|---|---|
| a git operation | `packages/core/src/git/command.ts` — the union, the risk, the argv. Nowhere else. |
| reading git's output | `packages/core/src/git/` — total parsers, no exceptions, keep the raw record |
| the graph picture | `packages/core/src/graph/layout.ts` (pure) and `apps/desktop/src/renderer/` (pixels) |
| a CLI command | `packages/cli/src/index.ts`, with `--json` and a documented exit code |
| a screen | `apps/desktop/src/renderer/`; anything crossing a process goes through `src/shared/api.ts` |
| a test fixture | `packages/core/test/support/fixtures.ts` — built with the real `git`, never using the product's executor |

## Rules that are not negotiable

- **No test that cannot fail.** No snapshots, no `toBeTruthy()` on something the test just built,
  no fixture typed by hand to match a parser. See the end of
  [docs/INVARIANTS.md](docs/INVARIANTS.md) for the list and the reasoning.
- **Nothing destructive without a confirmation.** If you add an operation that can lose work, it
  is `destructive` in `riskOf` and it takes a confirmation token. Do not add a bypass.
- **No shell.** `shell: true`, `exec`, or a command string built by concatenation is a rejected
  pull request, not a style preference.
- **No secrets in output.** Anything a command prints or returns goes through `redact`.
- **No new layer without deleting one.** `packages/core` may not import Electron, React or an HTTP
  client; the front-ends may not import `node:child_process`. `make verify` checks both.
- **No proprietary tier, no telemetry, no account requirement.** The project is MIT and stays MIT.

## Tests

```bash
make test          # everything
make prove         # re-measure the numbers the README claims
make mutate        # mutation testing over packages/core (slow, nightly)
make coverage      # coverage — informative, never a target
```

The interesting tests are the ones that check the product against something that is not the
product: real `git`, `--porcelain=v1`, `rev-parse`, random DAGs, mutation. If you are adding a
test, prefer that shape.

## Reporting a bug

Use the issue template. `orbitree doctor --json` output is the fastest way to make a report
actionable, and it contains no repository contents.

## Licence

By contributing you agree that your contribution is licensed under the MIT licence
([LICENSE](LICENSE)).
