# 4. Verification: check against something that is not the product

- **Status**: accepted
- **Date**: 2026-10-09

## Context

This project's own claims are its risk. "The app and the CLI agree", "the parsers handle any
repository", "the graph is correct" are the kind of statement that is easy to write, easy to
believe, and hard to check. The usual habits — a coverage threshold, a unit test per function, a
snapshot of the output — produce green CI and no confidence at all.

## Decision

Four kinds of check, in this order of preference:

1. **Cross-checks against an independent source.** The same question asked of git two ways:
   `--porcelain=v2` against `--porcelain=v1`, `rev-parse`, `symbolic-ref`,
   `ls-files --unmerged`, `ls-files --others`, `rev-list --count --left-right`. The expectations do
   not come from the code under test.
2. **Property-based tests over generated input**, wherever the input space is larger than the
   examples someone thinks of: the graph layout over random DAGs (including merges, roots,
   octopus merges and truncated windows), the argv builder, parser fuzzing over near-miss input.
3. **Fixtures built with the real `git` binary**, never with the product's own executor: a bug in
   argument building would otherwise produce a repository that matches the buggy expectation.
4. **Mutation testing** on `packages/core`, nightly. Coverage says a line ran; a mutation says a
   test noticed.

And **claims measured by a command**: the README's numbers come from `make prove`, which builds the
fixtures and prints what it found. A number in prose that no command produced is treated as a bug.

## Consequences

- The suite is slower than a pure-unit suite (real subprocesses, real filesystem) and it is worth
  it: it has already caught two real bugs that no unit test of the same functions would have.
- The invariant list is machine-checked in both directions
  (`bin/check-invariants.sh`), which stops the documentation from drifting away from the tests.
- Some kinds of test are refused outright; the list is in `docs/INVARIANTS.md` and the reason is
  the same every time: a test that cannot fail inflates confidence and sets the standard for the
  next one.
- A change that cannot be tested has to say so in its issue before the code is written.
