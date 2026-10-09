#!/usr/bin/env bash
# The traceability gate: every invariant the documentation claims has a test that names it,
# and every test that claims an invariant is one of the documented ones.
#
# Two directions on purpose. One direction alone would let either side drift: a claim with
# no test behind it, or a test tagged with an invariant that no longer exists.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

doc="docs/INVARIANTS.md"
fail=0

if [ ! -f "$doc" ]; then
  echo "check-invariants: $doc is missing" >&2
  exit 1
fi

claimed="$(grep -oE '^### I[0-9]+' "$doc" | grep -oE 'I[0-9]+' | sort -u || true)"
tagged="$(grep -rhoE '\[I[0-9]+\]' packages apps --include='*.test.ts' 2>/dev/null \
  | tr -d '[]' | sort -u || true)"

if [ -z "$claimed" ]; then
  echo "check-invariants: no '### In' headings found in $doc" >&2
  exit 1
fi

untested="$(comm -23 <(echo "$claimed") <(echo "$tagged"))"
undocumented="$(comm -13 <(echo "$claimed") <(echo "$tagged"))"

if [ -n "$untested" ]; then
  echo "check-invariants: claimed but not tested:" >&2
  echo "$untested" | sed 's/^/  /' >&2
  fail=1
fi

if [ -n "$undocumented" ]; then
  echo "check-invariants: tagged in tests but not described in $doc:" >&2
  echo "$undocumented" | sed 's/^/  /' >&2
  fail=1
fi

count="$(echo "$claimed" | grep -c . || true)"
if [ "$fail" -eq 0 ]; then
  echo "check-invariants: $count invariants, each one tested at least once"
fi
exit "$fail"
