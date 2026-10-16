import type { Commit } from '../git/log.ts';

/**
 * The commits a picture holds, given which names are not hidden.
 *
 * Hiding is a question about the **picture** and never about the repository: nothing is written, and
 * the answer is which commits the layout is handed.
 *
 * It is **reachability**, not a filter on badges. Hiding a branch's tip while keeping its ancestors
 * would leave lines going down to nothing, and a graph with lines to nowhere is a graph that lies
 * about the shape of the history. So a commit is in the picture when it is reachable from a name that
 * is not hidden — which is also what makes "hide this branch" mean what a person expects: the work
 * that exists only on that branch stops being drawn, and everything it shares stays.
 *
 * `visibleTips` must include HEAD when HEAD is not behind a name (a detached head, an unborn
 * repository's nothing), because the commit somebody is standing on is the one thing that must not
 * vanish from their own picture.
 */
export function visibleCommits(
  commits: readonly Commit[],
  visibleTips: readonly string[],
): readonly Commit[] {
  const byHash = new Map(commits.map((commit) => [commit.hash, commit]));
  const reachable = new Set<string>();
  const queue = [...visibleTips];
  while (queue.length > 0) {
    const hash = queue.pop() as string;
    if (reachable.has(hash)) continue;
    const commit = byHash.get(hash);
    // A tip outside the window is normal — the window is a page of a longer history — and it is not
    // an error: the commits between it and the window's edge simply are not here to draw.
    if (commit === undefined) continue;
    reachable.add(hash);
    for (const parent of commit.parents) queue.push(parent);
  }
  return commits.filter((commit) => reachable.has(commit.hash));
}
