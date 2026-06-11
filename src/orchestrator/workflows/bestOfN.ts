/**
 * Best-of-N inference-time scaling workflow.
 *
 * ADR 0001 §5.4 (best-of-N, objective reward / inference-time scaling).
 *
 * Generates N independent candidate outputs in parallel, scores each via an
 * injected async scorer, and returns the highest-scoring candidate. The key
 * insight from OpenHands-style verifiable autonomy is that the scorer must be
 * OBJECTIVE (an exit code, a deterministic check, or a judge agent) rather
 * than a vibe — this primitive enforces that discipline by delegating scoring
 * entirely to the caller.
 *
 * Each candidate receives a distinct prompt suffix so parallel calls explore
 * genuinely different solutions rather than collapsing to the same local
 * optimum. All candidates run under the runtime's shared semaphore and budget,
 * so nested fan-out is automatically rate-limited.
 */

import type { z } from "zod";
import type { AgentRun } from "../agent.ts";
import type { Runtime } from "../runtime.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BestOfNOptions<T> {
  /** The runtime that owns the concurrency semaphore and budget. */
  readonly runtime: Runtime;
  /** Number of independent candidates to generate. */
  readonly n: number;
  /** Base prompt; a variant suffix is appended per candidate. */
  readonly prompt: string;
  /** Zod schema for the structured output each candidate must return. */
  readonly schema: z.ZodType<T>;
  /**
   * Objective scorer. Receives the validated candidate and its full AgentRun.
   * Null candidates are never passed here — they automatically score -Infinity.
   * Higher is better; ties resolve to the lowest index.
   */
  readonly score: (candidate: T, run: AgentRun<T>) => Promise<number> | number;
  /** Optional system prompt forwarded verbatim to each agent call. */
  readonly systemPrompt?: string;
  /** Model override; falls back to the runtime's default model. */
  readonly model?: string;
  /** Prefix for the label field in each agent call (default: "best-of-n"). */
  readonly labelPrefix?: string;
}

export interface BestOfNResult<T> {
  /** The highest-scoring candidate, or null if every candidate was null. */
  readonly best: T | null;
  /** The score of the winning candidate, or -Infinity if all were null. */
  readonly bestScore: number;
  /** Full ranked list in original index order. */
  readonly candidates: ReadonlyArray<{ readonly data: T | null; readonly score: number }>;
}

// ---------------------------------------------------------------------------
// Variant suffix factory
// ---------------------------------------------------------------------------

/**
 * Returns the per-candidate prompt suffix for index `i` (0-based).
 * Does NOT use Math.random so the prompt injection is deterministic and
 * reproducible — each variant differs only by its ordinal label.
 */
function variantSuffix(i: number, n: number): string {
  return `\n\n(Candidate variant ${i + 1} of ${n}; explore a distinct approach.)`;
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

export async function bestOfN<T>(opts: BestOfNOptions<T>): Promise<BestOfNResult<T>> {
  const { runtime, n, prompt, schema, score, systemPrompt, model } = opts;
  const labelPrefix = opts.labelPrefix ?? "best-of-n";

  // Build thunks for runtime.parallel — each thunk returns [index, AgentRun<T>]
  // so we can correlate results back to their original ordering after the
  // Promise.all settles.
  type IndexedRun = readonly [index: number, run: AgentRun<T>];

  const thunks: ReadonlyArray<() => Promise<IndexedRun>> = Array.from(
    { length: n },
    (_, i) => () =>
      runtime
        .agent<T>(prompt + variantSuffix(i, n), {
          schema,
          label: `${labelPrefix}#${i}`,
          model,
          systemPrompt,
        })
        .then((run): IndexedRun => [i, run] as const),
  );

  const settled = await runtime.parallel(thunks);

  // Score every candidate; null data → -Infinity (no scorer call).
  const scored = await Promise.all(
    settled.map(async ([, run]): Promise<{ readonly data: T | null; readonly score: number }> => {
      if (run.data === null) {
        return { data: null, score: -Infinity };
      }
      const s = await score(run.data, run);
      return { data: run.data, score: s };
    }),
  );

  // Find the winner: highest score; ties go to the lowest original index
  // (Array.reduce visits left-to-right, keeping the first occurrence of the max).
  let bestScore = -Infinity;
  let best: T | null = null;

  for (const candidate of scored) {
    if (candidate.score > bestScore) {
      bestScore = candidate.score;
      best = candidate.data;
    }
  }

  return { best, bestScore, candidates: scored };
}
