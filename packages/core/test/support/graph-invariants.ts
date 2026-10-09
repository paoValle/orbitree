/**
 * The layout's invariants, written as a checker rather than as prose.
 *
 * The tests run this over random DAGs and over a real repository. Anything the renderer
 * would draw wrongly — a line from nowhere, a commit drawn twice, an edge pointing at the
 * wrong row — has to show up here as a string.
 */
import type { Commit } from '../../src/git/log.ts';
import { type GraphLayout, layoutGraph } from '../../src/graph/layout.ts';

export function layoutViolations(commits: readonly Commit[], layout: GraphLayout): string[] {
  const problems: string[] = [];
  const { rows, edges, laneCount } = layout;

  if (rows.length !== commits.length) {
    problems.push(`row count ${rows.length} != commit count ${commits.length}`);
  }
  for (const [index, row] of rows.entries()) {
    const commit = commits[index];
    if (commit === undefined || row.commit.hash !== commit.hash) {
      problems.push(`row ${index} is not the commit at that position`);
    }
    if (row.row !== index) problems.push(`row ${index} reports row ${row.row}`);
    if (!Number.isInteger(row.lane) || row.lane < 0) {
      problems.push(`row ${index} has lane ${row.lane}`);
    }
    if (row.lane >= laneCount)
      problems.push(`row ${index} lane ${row.lane} >= laneCount ${laneCount}`);

    for (const [what, lanes] of [
      ['through', row.through],
      ['incoming', row.incoming],
      ['outgoing', row.outgoing],
    ] as const) {
      const unique = new Set(lanes);
      if (unique.size !== lanes.length) problems.push(`row ${index} ${what} has a duplicate lane`);
      const sorted = [...lanes].every((lane, i) => i === 0 || (lanes[i - 1] as number) < lane);
      if (!sorted) problems.push(`row ${index} ${what} is not ascending: ${lanes.join(',')}`);
      for (const lane of lanes) {
        if (!Number.isInteger(lane) || lane < 0 || lane >= laneCount) {
          problems.push(`row ${index} ${what} contains lane ${lane} outside 0..${laneCount - 1}`);
        }
      }
      if (lanes.includes(row.lane) && what !== 'outgoing') {
        problems.push(`row ${index} ${what} contains the commit's own lane ${row.lane}`);
      }
    }
    for (const lane of row.through) {
      if (row.incoming.includes(lane)) {
        problems.push(`row ${index} lane ${lane} is both passing and merging`);
      }
      if (row.outgoing.includes(lane)) {
        problems.push(`row ${index} lane ${lane} is both passing and outgoing`);
      }
    }

    // Continuity: a line that passes a row must have existed one row above. This is the
    // check that catches a lane that appears out of nowhere halfway down the picture.
    if (index > 0) {
      const above = rows[index - 1];
      if (above !== undefined) {
        const available = new Set([...above.through, ...above.outgoing]);
        for (const lane of row.through) {
          if (!available.has(lane)) {
            problems.push(
              `row ${index} has a passing line in lane ${lane} that starts from nowhere`,
            );
          }
        }
      }
    }
  }

  const seen = new Set<string>();
  for (const edge of edges) {
    const key = `${edge.childRow}:${edge.parentIndex}`;
    if (seen.has(key)) problems.push(`duplicate edge for ${key}`);
    seen.add(key);

    const child = commits[edge.childRow];
    const parent = commits[edge.parentRow];
    if (child === undefined || parent === undefined) {
      problems.push(`edge ${key} points outside the window`);
      continue;
    }
    if (edge.childRow >= edge.parentRow) {
      problems.push(`edge ${key} does not go downwards (${edge.childRow} -> ${edge.parentRow})`);
      continue;
    }
    if (child.parents[edge.parentIndex] !== parent.hash) {
      problems.push(`edge ${key} does not match parents[${edge.parentIndex}] of ${child.hash}`);
    }
    const childRow = rows[edge.childRow];
    const parentRow = rows[edge.parentRow];
    if (childRow !== undefined && edge.childLane !== childRow.lane) {
      problems.push(
        `edge ${key} leaves from lane ${edge.childLane}, not the child's lane ${childRow.lane}`,
      );
    }
    if (parentRow !== undefined && edge.parentLane !== parentRow.lane) {
      problems.push(
        `edge ${key} lands on lane ${edge.parentLane}, not the parent's lane ${parentRow.lane}`,
      );
    }
  }

  // Every parent inside the window has exactly one edge, and no more.
  for (const [childRow, commit] of commits.entries()) {
    for (const [parentIndex, parent] of commit.parents.entries()) {
      const parentRow = commits.findIndex((candidate) => candidate.hash === parent);
      if (parentRow === -1) continue;
      if (!seen.has(`${childRow}:${parentIndex}`)) {
        problems.push(`no edge from row ${childRow} to its parent ${parent.slice(0, 7)}`);
      }
    }
  }

  return problems;
}

/** Determinism, checked by running the layout twice on the same input. */
export function isDeterministic(commits: readonly Commit[]): boolean {
  const first = JSON.stringify(layoutGraph(commits));
  const second = JSON.stringify(layoutGraph(commits));
  return first === second;
}
