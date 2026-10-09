# 1. Desktop stack: Electron, with the trade-off written down

- **Status**: accepted
- **Date**: 2026-10-09

## Context

The product is a graphical Git client for Windows, macOS and Linux. Its value is concentrated in
two places: a commit graph that must be drawn identically everywhere, and a diff view. Both are
rendering-bound. The git work is a subprocess either way.

## Decision

Electron 44 (Chromium 152) with React 19 and Vite 7, packaged by electron-builder 26.

## Consequences

**Accepted cost**: installers of roughly 100 MB, and the RAM of a browser process. Stated in the
README rather than discovered at download time, and measured by CI rather than estimated.

**Bought**: one rendering engine, so a curve that looks right on macOS looks right on Linux;
Node's `child_process` for the `git` binary with no native addons and no ABI rebuilds per
Electron release; one language for the whole product; the ability to share types between the
processes, which is what makes the IPC contract checkable at compile time.

**Rejected alternatives**:

- *Tauri 2*: smaller installers, at the price of three different webviews. WebKitGTK versus
  WebView2 versus WKWebView differences in canvas rendering, fonts and CSS would be chased on
  the product's most important surface, and the git layer would move to Rust — a second language
  for a solo project whose bottleneck is not runtime performance. Reconsider if installer size
  becomes the deciding objection.
- *Native per platform*: three codebases for a two-feature product.
- *A server plus a browser*: removes the local-first property, which is a non-goal to break.

**Revisit when**: an install-size objection outweighs the rendering-consistency requirement, or
the git work becomes the bottleneck (it will not: `git` is the process that does the work).
