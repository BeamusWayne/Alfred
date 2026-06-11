/**
 * Generic iterative PageRank (ADR 0002).
 *
 * Pure, deterministic, zero-dependency. Suitable for the file-reference graph
 * built by repomap.ts. The algorithm follows the standard formulation:
 *   PR(u) = (1 - d) + d * Σ_v [ w(v→u) / out_weight(v) * PR(v) ]
 * where d = damping factor (default 0.85).
 */

export interface Edge {
  readonly from: string;
  readonly to: string;
  readonly weight: number;
}

export interface PageRankOptions {
  /** Damping factor (default 0.85). */
  readonly damping?: number;
  /** Maximum iteration count (default 100). */
  readonly maxIterations?: number;
  /** Convergence tolerance (default 1e-6). */
  readonly tolerance?: number;
}

/**
 * Compute PageRank for a directed weighted graph.
 *
 * @param nodes   Complete list of node IDs (must include all nodes, even sinks).
 * @param edges   Directed edges with positive weights.
 * @param opts    Tuning parameters.
 * @returns       Map from node ID → rank score (scores sum to ~1).
 */
export function pageRank(
  nodes: readonly string[],
  edges: readonly Edge[],
  opts?: PageRankOptions,
): Map<string, number> {
  const damping = opts?.damping ?? 0.85;
  const maxIterations = opts?.maxIterations ?? 100;
  const tolerance = opts?.tolerance ?? 1e-6;

  if (nodes.length === 0) {
    return new Map<string, number>();
  }

  const n = nodes.length;
  const nodeIndex = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const node = nodes[i];
    if (node !== undefined) nodeIndex.set(node, i);
  }

  // Build adjacency: for each source node, collect [targetIndex, weight] pairs
  // and total outgoing weight.
  const outEdges: Array<Array<readonly [number, number]>> = Array.from({ length: n }, () => []);
  const outWeight: number[] = new Array(n).fill(0) as number[];

  for (const edge of edges) {
    const fi = nodeIndex.get(edge.from);
    const ti = nodeIndex.get(edge.to);
    if (fi === undefined || ti === undefined || edge.weight <= 0) continue;
    (outEdges[fi] as Array<readonly [number, number]>).push([ti, edge.weight]);
    (outWeight[fi] as number) = ((outWeight[fi] as number) ?? 0) + edge.weight;
  }

  // Initialise ranks uniformly
  const initial = 1 / n;
  let ranks: number[] = new Array(n).fill(initial) as number[];

  const teleport = (1 - damping) / n;

  for (let iter = 0; iter < maxIterations; iter++) {
    const next: number[] = new Array(n).fill(teleport) as number[];

    for (let fi = 0; fi < n; fi++) {
      const ow = outWeight[fi] ?? 0;
      if (ow === 0) {
        // Dangling node: distribute rank evenly (standard dangling-node fix)
        const share = (damping * (ranks[fi] ?? 0)) / n;
        for (let ti = 0; ti < n; ti++) {
          (next[ti] as number) += share;
        }
      } else {
        const edges_ = outEdges[fi] ?? [];
        for (const [ti, w] of edges_) {
          (next[ti] as number) += (damping * (ranks[fi] ?? 0) * w) / ow;
        }
      }
    }

    // Check convergence (L1 norm)
    let delta = 0;
    for (let i = 0; i < n; i++) {
      delta += Math.abs((next[i] ?? 0) - (ranks[i] ?? 0));
    }

    ranks = next;
    if (delta < tolerance) break;
  }

  const result = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const node = nodes[i];
    if (node !== undefined) {
      result.set(node, ranks[i] ?? 0);
    }
  }
  return result;
}
