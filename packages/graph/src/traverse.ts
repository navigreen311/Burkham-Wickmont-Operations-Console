/**
 * Graph traversal - pure.
 *
 * Every walk here is bounded by a visited set, and not defensively: **cycles are the thing being
 * looked for.** A cross-guarantee cycle - A guarantees B, B guarantees A - is exactly what turns
 * an apparently diversified capital stack into a single point of failure, because one default
 * cascades through the whole ring. Code that assumed a tree would hang on precisely the input
 * this module exists to find.
 */

import { activeEdges, type EdgeKind, type Graph } from './model.js';

interface Adjacency {
  readonly to: string;
  readonly edgeId: string;
}

/** Adjacency over entity-to-entity edges of the given kinds. External endpoints are terminal. */
const adjacency = (graph: Graph, kinds: readonly EdgeKind[]): Map<string, Adjacency[]> => {
  const map = new Map<string, Adjacency[]>();

  for (const edge of graph.edges) {
    if (edge.endedAt !== null) continue;
    if (!kinds.includes(edge.kind)) continue;
    if (edge.fromKind !== 'entity' || edge.toKind !== 'entity' || edge.toId === null) continue;

    const existing = map.get(edge.fromId) ?? [];
    existing.push({ to: edge.toId, edgeId: edge.id });
    map.set(edge.fromId, existing);
  }

  return map;
};

/** Entities reachable from a starting entity along the given edge kinds, excluding the start. */
export const reachableEntities = (
  graph: Graph,
  startEntityId: string,
  kinds: readonly EdgeKind[],
): readonly string[] => {
  const map = adjacency(graph, kinds);
  const seen = new Set<string>([startEntityId]);
  const queue = [startEntityId];
  const found: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const next of map.get(current) ?? []) {
      if (seen.has(next.to)) continue;
      seen.add(next.to);
      found.push(next.to);
      queue.push(next.to);
    }
  }

  return found;
};

export interface Cycle {
  /** Entity ids in traversal order, first repeated member omitted. */
  readonly members: readonly string[];
  readonly kind: EdgeKind;
}

/**
 * Every simple cycle over the given edge kinds.
 *
 * Depth-first with an explicit recursion stack. Deduplicated by rotating each cycle to start at
 * its lexicographically smallest member, so the same ring found from three different entry points
 * is reported once rather than three times - a report that lists the same cycle repeatedly reads
 * as three problems and gets discounted as noise.
 */
export const findCycles = (graph: Graph, kinds: readonly EdgeKind[]): readonly Cycle[] => {
  const map = adjacency(graph, kinds);
  const found = new Map<string, Cycle>();

  const visit = (node: string, path: string[], onPath: Set<string>, kind: EdgeKind): void => {
    for (const next of map.get(node) ?? []) {
      if (onPath.has(next.to)) {
        const start = path.indexOf(next.to);
        if (start === -1) continue;
        const members = path.slice(start);
        found.set(canonical(members), { members: rotate(members), kind });
        continue;
      }

      path.push(next.to);
      onPath.add(next.to);
      visit(next.to, path, onPath, kind);
      onPath.delete(next.to);
      path.pop();
    }
  };

  for (const kind of kinds) {
    const perKind = adjacency(graph, [kind]);
    for (const start of perKind.keys()) {
      visit(start, [start], new Set([start]), kind);
    }
  }

  return [...found.values()];
};

/** Rotate so the smallest id leads, making the same ring compare equal from any entry point. */
const rotate = (members: readonly string[]): readonly string[] => {
  if (members.length === 0) return members;
  let smallest = 0;
  for (let i = 1; i < members.length; i += 1) {
    if ((members[i] as string) < (members[smallest] as string)) smallest = i;
  }
  return [...members.slice(smallest), ...members.slice(0, smallest)];
};

const canonical = (members: readonly string[]): string => rotate(members).join('>');

/**
 * The connected component containing a node, over the given kinds, ignoring direction.
 *
 * Direction-insensitive on purpose: two entities linked by a control edge are in the same
 * household whichever way the edge points, and a subgraph that followed direction would show a
 * holding company's subsidiaries but not, from a subsidiary, its parent.
 */
export const componentOf = (
  graph: Graph,
  startId: string,
  kinds: readonly EdgeKind[],
): readonly string[] => {
  const undirected = new Map<string, Set<string>>();

  const link = (a: string, b: string): void => {
    if (!undirected.has(a)) undirected.set(a, new Set());
    (undirected.get(a) as Set<string>).add(b);
  };

  for (const edge of activeEdges(graph)) {
    if (!kinds.includes(edge.kind)) continue;
    if (edge.toId === null) continue;
    link(edge.fromId, edge.toId);
    link(edge.toId, edge.fromId);
  }

  const seen = new Set<string>([startId]);
  const queue = [startId];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const next of undirected.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }

  seen.delete(startId);
  return [...seen];
};
