# Architecture

## The shape

```
                 ┌─────────────────────────────────────────────┐
   Electron      │  renderer (React)                           │
   main process  │  graph canvas, working tree, quick commands  │
                 └───────────────▲─────────────────────────────┘
                                 │ contextBridge: a fixed list of
                                 │ channels, zod-validated payloads
                 ┌───────────────┴─────────────────────────────┐
                 │  preload (whitelist) + main (IPC handlers)   │
                 └───────────────▲─────────────────────────────┘
                                 │  imports
   ┌─────────────────────────────┴─────────────────────────────┐
   │  @keplerk/core                                             │
   │  command union → risk → argv → executor → parsers → layout │
   │  no Electron, no React, no network                         │
   └─────────────────────────────▲─────────────────────────────┘
                                 │  imports (the same package)
                 ┌───────────────┴─────────────────────────────┐
                 │  @keplerk/cli   status/graph/refs/run/…      │
                 └─────────────────────────────────────────────┘
                                 │  spawn, argv array, shell:false
                             the installed `git`
```

`packages/core` is the product. The desktop app and the CLI are two interfaces to it. This is
not a style preference: it is what makes "everything the GUI does, an agent can do" a fact
rather than a promise, and it is enforced by `[I3]` and `[I7]` in `docs/INVARIANTS.md`.

## Decisions and why

### One renderer everywhere: Electron

| | Electron | Tauri 2 | native (Qt/SwiftUI/GTK) |
|---|---|---|---|
| rendering | one Chromium, identical on all three | three webviews (WebView2, WKWebView, WebKitGTK) | three toolkits |
| the git process | Node `child_process`, no bindings | Rust, `git2` or shell out | native, per platform |
| language surface | TypeScript, one language | TypeScript + Rust | 2–3 languages |
| installer | ~100 MB | single-digit MB | smallest |
| the work in a graph-drawing client | the canvas, the diff, the layout | same, plus per-platform webview differences | three times over |

A commit graph and a diff view are rendering-bound, and they are the product. Paying ~100 MB to
render them identically on three operating systems is the right trade; paying in webview
divergence for an unknown-but-different bug on Linux is not. The RAM and download objections are
real and are answered in the README, not hidden. See `docs/adr/0001-desktop-stack.md`.

### Git is the installed `git`

`spawn('git', argv)` with an argv array, `shell: false`. Not libgit2 bindings, not a
re-implementation.

- **Correctness comes free.** Rebase, merge, hooks, attributes, credential helpers, filter
  drivers, GPG signing: the semantics are git's, because it is git.
- **No native addons.** `nodegit`-class dependencies need a rebuild per Node and per Electron
  ABI; that is a support burden for a client whose job is to be reliable.
- **Cost accepted**: `git` must be on `PATH`, at a version we state (`2.43`). `keplerk doctor`
  checks it and says what to install. Bundling a git binary for Windows is a packaging decision
  for a later release, not a hidden requirement now.

See `docs/adr/0002-git-access.md`.

### One guarded gateway, not a helper per feature

Every git invocation is one of the `GitCommand` variants in
`packages/core/src/git/command.ts`. Three consequences:

1. **`toArgv` is a pure function**, so the dangerous lines are unit-testable: paths always after
   `--`, a forced push is always `--force-with-lease`, `clean` never passes `-x`.
2. **`riskOf` is an exhaustive switch.** Adding an operation without giving it a risk is a
   compile error, and the executor refuses anything `destructive` without a confirmation token.
3. **There is no other place to be careless.** No feature file builds an argv.

### The parsers are total

`parseStatus` and `parseLog` return `{ ok: true, value } | { ok: false, error, record }`. They
never throw and never drop a record: every entry carries the `raw` line it came from, so a git
version that adds a field does not need a parser change to be visible.

### The graph layout is a pure function

`layoutGraph(commits) → { rows, edges, laneCount }`. No font metrics, no canvas, no DOM. Layout
is where the subtle bugs live (a line from a lane a commit is not in), so it is the piece with
property-based tests over random DAGs and a checker (`layoutViolations`) that recomputes the
invariants from the output.

Rendering is a single `<canvas>` behind DOM rows: curves are drawn in one element, commit
subjects stay selectable text with real accessibility. No graph library: the layout is a hundred
lines and the styling is the product's own.

### The renderer is untrusted

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, a CSP with no `eval` and no
remote origins, `setWindowOpenHandler` denying everything and opening links in the real browser,
and a preload that exposes a fixed set of named functions instead of a generic `invoke`. Inbound
IPC payloads are parsed with zod before any git argument is built, and the IPC schema is
asserted at compile time to cover the core's command union.

### Platforms

| | macOS | Windows | Linux |
|---|---|---|---|
| shell | Electron 44 | Electron 44 | Electron 44 |
| git | system git ≥ 2.43 | Git for Windows on `PATH` | system git ≥ 2.43 |
| artifact | dmg + zip, signed and notarised | NSIS, signed | AppImage + deb |
| tests | full suite + app smoke | full suite + app smoke | full suite + app smoke |

CI runs the suite on all three. Fixtures configure their own repositories (`core.autocrlf=false`,
`core.gpgsign=false`) so a developer's global configuration cannot change a test result, and the
fixtures set `LC_ALL=C` while the product does not: porcelain v2 is stable, and error messages
are better in the user's own language.

## Layers, and the rule between them

| Layer | May import | May not |
|---|---|---|
| `packages/core` | `node:*`, nothing else | Electron, React, HTTP clients, `apps/*` |
| `packages/cli` | `@keplerk/core`, node, `commander` | `child_process` directly, `apps/*` |
| `apps/desktop/src/main`, `src/preload` | `@keplerk/core`, Electron, `zod` | the renderer's modules |
| `apps/desktop/src/shared` | types and schemas only | node builtins, Electron |
| `apps/desktop/src/renderer` | `shared`, React | node builtins, Electron, `@keplerk/core`'s runtime |

The first and the second row of prohibitions are checked by a test
(`packages/core/test/boundaries.test.ts`), because a layering rule that nobody verifies is a
comment.

## Build and toolchain

| Concern | Choice | Why |
|---|---|---|
| packages | pnpm workspaces | strict node_modules, no phantom dependencies |
| language | TypeScript 7, strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` | the compiler is the first invariant |
| app bundling | electron-vite 5 (Vite 7) | one config for main, preload, renderer |
| UI | React 19, one stylesheet, no component library yet | a design system before a screen is backwards |
| tests | Vitest 5, fast-check for properties, real `git` for fixtures | see `docs/INVARIANTS.md` |
| lint + format | Biome 2 | one tool, no TypeScript-programmatic-API dependency |
| mutation | Stryker 10, on `packages/core` | coverage proves a line ran; a mutation proves a test noticed |
| CLI runtime | `node --experimental-strip-types` | no build step between an edit and a run |

**No-build constraint on the core and the CLI**: no `enum`, no `namespace`, no constructor
parameter properties. Those three cannot be type-stripped, so they would force a build step on
the CLI for nothing. `make cli` in CI runs the CLI from source, which catches the mistake the
moment it is made.

## Where things live

```
packages/core/src/git/command.ts    the command union, risk, argv (the only argv builder)
packages/core/src/git/exec.ts       spawn, env, timeouts, redaction, confirmation gate
packages/core/src/git/status.ts     porcelain v2 parser
packages/core/src/git/log.ts        log and for-each-ref parsers
packages/core/src/graph/layout.ts   pure lanes and edges
packages/core/src/repo.ts           openRepo, readStatus, readGraph, readRefs, run
packages/cli/src/index.ts           argv → core → JSON envelope
apps/desktop/src/main/index.ts      window, IPC handlers (the only place that answers IPC)
apps/desktop/src/renderer/          React: graph canvas, working tree, quick commands
docs/                               product, roadmap, architecture, invariants, CLI contract
```
