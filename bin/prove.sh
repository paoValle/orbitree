#!/usr/bin/env bash
# Re-measures the numbers the README claims, from a real run.
#
# The README's table is only allowed to contain numbers that this command printed. Run it
# before quoting any of them, and copy what came out.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

printf '# measured %s on %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(uname -s)" "$(uname -m)"
pnpm exec vitest run packages/core/test/prove.test.ts --reporter=default
