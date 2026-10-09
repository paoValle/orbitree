#!/usr/bin/env bash
# Builds a repository big enough to measure the product against, not to be realistic in its
# contents. A linear history would only stress the parser; a merge every `merge-every`
# commits also stresses the lanes, the refs and the edges, which is where a graph client
# slows down.
#
# Usage: bin/make-big-repo.sh <directory> <main commits> [merge every]
set -euo pipefail

target="${1:?usage: make-big-repo.sh <directory> <main commits> [merge every]}"
mains="${2:?a number of commits on main}"
every="${3:-25}"

rm -rf "$target"
mkdir -p "$target"
cd "$target"

git init -q -b main
git config user.name 'Fixture Author'
git config user.email 'fixture@example.invalid'
git config commit.gpgsign false
git config core.autocrlf false

# A fixed date keeps two runs comparable: a difference then comes from the code, not the clock.
export GIT_AUTHOR_DATE='2026-01-01T00:00:00+00:00'
export GIT_COMMITTER_DATE="$GIT_AUTHOR_DATE"

printf 'the first line\n' > main.txt
git add main.txt
git commit -qm 'the first commit'

i=1
while [ "$i" -le "$mains" ]; do
  printf 'line %s\n' "$i" >> main.txt
  git add main.txt
  git commit -qm "main commit $i"

  if [ $((i % every)) -eq 0 ]; then
    branch="feature-$i"
    # Branching from one commit back guarantees a real merge rather than a fast-forward.
    git checkout -q -b "$branch" HEAD~1
    printf 'feature %s\n' "$i" > "feature-$i.txt"
    git add "feature-$i.txt"
    git commit -qm "the feature for $i"
    git checkout -q main
    git merge -q --no-edit "$branch"
  fi
  i=$((i + 1))
done

git checkout -q -b unmerged-feature
printf 'not merged\n' > unmerged.txt
git add unmerged.txt
git commit -qm 'a branch nobody merged'
git checkout -q main
git tag -a v1 -m 'the first tag' HEAD~5

printf 'commits: %s\nrefs: %s\npath: %s\n' \
  "$(git rev-list --count HEAD)" \
  "$(git for-each-ref | wc -l | tr -d ' ')" \
  "$(pwd -P)"
