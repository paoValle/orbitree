import type { Commit } from '../git/log.ts';

/**
 * Deterministic, pure layout for the commit graph.
 *
 * "Pure" is the whole design: same commits in, same picture out, no measurement of text,
 * no canvas, no font metrics. The renderer decides pixels; this decides lanes.
 *
 * The input must be topologically sorted (children before parents), which is what
 * `git log --topo-order` produces. A parent that falls outside the window is normal
 * (that is what a history limit does) and is drawn as a line leaving the bottom.
 */

export interface GraphRow {
  readonly commit: Commit;
  readonly row: number;
  /** The column of this commit's node. */
  readonly lane: number;
  /** Lanes with a line passing the node, not touching it. */
  readonly through: readonly number[];
  /** Lanes whose awaited commit is this one: the merge sources, excluding `lane`. */
  readonly incoming: readonly number[];
  /** Lanes carrying this commit's parents downwards, `lane` first. */
  readonly outgoing: readonly number[];
}

export interface GraphEdge {
  readonly childRow: number;
  readonly childLane: number;
  readonly parentRow: number;
  readonly parentLane: number;
  /** 0 for the first parent, 1 for a merge source, and so on. */
  readonly parentIndex: number;
}

export interface GraphLayout {
  readonly rows: readonly GraphRow[];
  readonly edges: readonly GraphEdge[];
  readonly laneCount: number;
}

export class NotTopologicallySortedError extends Error {
  override readonly name = 'NotTopologicallySortedError';
}

interface Slot {
  /** The commit this lane is waiting to draw, or `null` when the lane is free. */
  awaiting: string | null;
  from: { row: number; parentIndex: number; lane: number } | null;
}

export function layoutGraph(commits: readonly Commit[]): GraphLayout {
  const rowOf = new Map<string, number>();
  for (let index = 0; index < commits.length; index += 1) {
    const commit = commits[index];
    if (commit === undefined) continue;
    if (rowOf.has(commit.hash)) {
      throw new NotTopologicallySortedError(`commit ${commit.hash} appears twice`);
    }
    rowOf.set(commit.hash, index);
  }
  for (const [index, commit] of commits.entries()) {
    for (const parent of commit.parents) {
      const parentRow = rowOf.get(parent);
      // A parent outside the window is fine; one that appears *before* its child is not,
      // and would produce a line going upwards.
      if (parentRow !== undefined && parentRow <= index) {
        throw new NotTopologicallySortedError(
          `parent ${parent} of ${commit.hash} is listed before it; the log is not in topological order`,
        );
      }
    }
  }

  const slots: Slot[] = [];
  const rows: GraphRow[] = [];
  const edges: GraphEdge[] = [];

  for (let row = 0; row < commits.length; row += 1) {
    const commit = commits[row];
    if (commit === undefined) continue;

    const occupied = new Set<number>();
    const terminating: number[] = [];
    for (let lane = 0; lane < slots.length; lane += 1) {
      const slot = slots[lane];
      if (slot === undefined || slot.awaiting === null) continue;
      occupied.add(lane);
      if (slot.awaiting === commit.hash) terminating.push(lane);
    }

    let lane: number;
    if (terminating.length > 0) {
      lane = terminating[0] as number;
      for (const source of terminating) {
        const from = slots[source]?.from ?? null;
        if (from !== null) {
          edges.push({
            childRow: from.row,
            childLane: from.lane,
            parentRow: row,
            parentLane: lane,
            parentIndex: from.parentIndex,
          });
        }
      }
      for (const source of terminating) {
        if (source !== lane) slots[source] = { awaiting: null, from: null };
      }
    } else {
      lane = firstFreeLane(slots);
      if (lane === slots.length) slots.push({ awaiting: null, from: null });
    }

    const through = [...occupied]
      .filter((candidate) => candidate !== lane && !terminating.includes(candidate))
      .sort((a, b) => a - b);
    const incoming = terminating.filter((candidate) => candidate !== lane);

    const [firstParent, ...restParents] = commit.parents;
    slots[lane] =
      firstParent === undefined
        ? { awaiting: null, from: null }
        : { awaiting: firstParent, from: { row, parentIndex: 0, lane } };

    const outgoing = [lane];
    for (const [offset, parent] of restParents.entries()) {
      // Never reuse a lane that already awaits this parent: that lane's `from` record is
      // the other child's edge, and overwriting it loses a line from the picture.
      const target = firstFreeLane(slots);
      if (target === slots.length) slots.push({ awaiting: null, from: null });
      // `from.lane` is where the line *starts* — the child's lane — while `target` is the
      // lane the parent will be drawn in. Conflating the two is what the invariant test
      // caught: a line appeared to leave from a lane the commit is not in.
      slots[target] = {
        awaiting: parent,
        from: { row, parentIndex: offset + 1, lane },
      };
      outgoing.push(target);
    }

    rows.push({
      commit,
      row,
      lane,
      through,
      incoming,
      outgoing: [...outgoing].sort((a, b) => a - b),
    });
  }

  const laneCount = rows.reduce((count, row) => {
    const highest = Math.max(row.lane, ...row.through, ...row.outgoing);
    return Math.max(count, highest + 1);
  }, 0);

  return { rows, edges, laneCount };
}

function firstFreeLane(slots: readonly Slot[]): number {
  for (let lane = 0; lane < slots.length; lane += 1) {
    if (slots[lane]?.awaiting === null) return lane;
  }
  return slots.length;
}

/** Refs keyed by the commit they point at, for drawing badges on the graph. */
export function refsByOid(
  refs: readonly {
    name: string;
    shortName: string;
    kind: string;
    target: string;
    isHead: boolean;
  }[],
): Map<string, readonly { name: string; shortName: string; kind: string; isHead: boolean }[]> {
  const byOid = new Map<
    string,
    { name: string; shortName: string; kind: string; isHead: boolean }[]
  >();
  for (const ref of refs) {
    const list = byOid.get(ref.target) ?? [];
    // `HEAD` first, then branches by name: the order the badges are drawn in.
    list.push({
      name: ref.name,
      shortName: ref.shortName,
      kind: ref.kind,
      isHead: ref.isHead,
    });
    byOid.set(ref.target, list);
  }
  const rank: Readonly<Record<string, number>> = { branch: 0, remote: 1, tag: 2, other: 3 };
  for (const list of byOid.values()) {
    list.sort((a, b) => {
      if (a.isHead !== b.isHead) return a.isHead ? -1 : 1;
      const byKind = (rank[a.kind] ?? 3) - (rank[b.kind] ?? 3);
      if (byKind !== 0) return byKind;
      return a.shortName.localeCompare(b.shortName);
    });
  }
  return byOid;
}
