## What this changes

<!-- One paragraph. What was wrong or missing, and what the change does about it. -->

Closes #

## How it was verified

<!-- The command, and the line it printed. Not "tests pass". -->

```bash
make verify
```

## Checklist

- [ ] An issue exists for this, and this pull request closes it.
- [ ] The test fails without the change (or the issue says why it cannot be tested).
- [ ] `make verify` is green locally.
- [ ] No `spawn`/`execFile` outside `packages/core/src/git/exec.ts`; no `shell: true`.
- [ ] A new git operation has a risk in `riskOf`, and a destructive one needs a confirmation.
- [ ] A new invariant is added to `docs/INVARIANTS.md` **and** has a test titled `[In]`.
- [ ] No number in this pull request, or in the documentation it changes, was written without running `make prove`.
- [ ] No new dependency (or a paragraph above saying why the standard library will not do).
- [ ] `docs/ROADMAP.md` phase boxes are ticked only for items whose exit command has run.
