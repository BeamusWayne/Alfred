/**
 * Eval harness type definitions — replay + assert regressions.
 *
 * ADR 0004 (eval harness — replay + assert regressions): treat the agent like
 * production software by replaying a recorded trajectory (a deterministic
 * MockProvider script set) through the REAL engine and asserting no regressions
 * on tool call sequence, terminal status, and final text substrings.
 */
import type { Script } from "../providers/mock.ts";
import type { QueryState } from "../query/types.ts";

/**
 * What a single eval case must satisfy. All fields are optional; omitting a
 * field skips that assertion.
 */
export interface EvalExpectation {
  /** The terminal status the loop must produce. */
  readonly status?: QueryState["status"];
  /** Every tool in this list must appear in the observed tool_use events, in order. */
  readonly toolsUsed?: readonly string[];
  /** The total number of tool_use events must not exceed this count. */
  readonly toolCallCountAtMost?: number;
  /** Each string must appear as a substring of the final assistant text. */
  readonly finalTextIncludes?: readonly string[];
}

/**
 * A single reproducible eval case: a prompt, a deterministic provider script,
 * and the expectations to assert.
 */
export interface EvalCase {
  readonly name: string;
  readonly prompt: string;
  /** Ordered list of MockProvider scripts that define the recorded trajectory. */
  readonly scripts: readonly Script[];
  readonly expect: EvalExpectation;
}

/**
 * The outcome of running one EvalCase through runEvalCase().
 */
export interface EvalResult {
  readonly name: string;
  readonly passed: boolean;
  /** Human-readable descriptions of every failed assertion (empty when passed). */
  readonly failures: readonly string[];
  /** Names of every tool_use event observed during the run, in call order. */
  readonly toolsUsed: readonly string[];
  readonly status: QueryState["status"];
  readonly turns: number;
}

/**
 * Aggregated outcome of a full eval suite.
 */
export interface EvalReport {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly results: readonly EvalResult[];
}
