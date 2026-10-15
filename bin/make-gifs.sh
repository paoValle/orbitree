#!/usr/bin/env bash
# Builds the README's GIFs from the product, rather than from a screen recording.
#
# `apps/desktop/test/demo` drives the real window through three short sequences and writes one
# PNG per step under `reports/demo/`; this turns each sequence into a GIF under `docs/media/`.
# The frames are artifacts and stay ignored. The GIFs are committed, because a README has to
# render on GitHub.
#
# ffmpeg is the one tool here that is not already a dependency of the project: it is a build-time
# convenience for a documentation artefact, never something the product runs.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is not installed; it is what turns the frames into GIFs" >&2
  exit 1
fi

# The frames are written by the demo configuration, not by the suite: `make e2e` must not run it.
pnpm --filter @orbitree/desktop exec playwright test --config playwright.demo.config.ts

frames="apps/desktop/reports/demo"
out="docs/media"
mkdir -p "$out"

for dir in "$frames"/*/; do
  sequence="$(basename "$dir")"
  first="$(find "$dir" -name '01.png' | head -1)"
  if [ -z "$first" ]; then
    echo "no frames in $dir" >&2
    exit 1
  fi
  count="$(find "$dir" -name '*.png' | wc -l | tr -d ' ')"
  gif="$out/$sequence.gif"
  # One frame and a quarter per second: fast enough to read as movement, slow enough to see what
  # changed between two frames. 960 wide, because that is how wide a README renders it, and a
  # 128-colour palette because a window of flat panels does not need more.
  ffmpeg -loglevel error -y -framerate 1.25 -start_number 1 -i "$dir/%02d.png" \
    -vf "scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=3" \
    -loop 0 "$gif"
  printf '%s: %s frames, %s\n' "$gif" "$count" "$(du -h "$gif" | cut -f1)"
done
