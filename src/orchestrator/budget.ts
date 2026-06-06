/**
 * Orchestration token/cost budget — ADR 0001 §5 (token budget).
 *
 * Wraps the immutable `CostTracker` with hard limits on USD spend and total
 * token consumption. Like `CostTracker`, every mutating operation returns a
 * NEW `Budget` instance; the original is never modified.
 *
 * Usage in the harness:
 *   let budget = new Budget({ maxUsd: 1.00, maxTokens: 500_000 });
 *   budget = budget.record(model, agentRun.cost.usage);
 *   if (budget.exceeded()) return; // stop spawning agents
 */

import { CostTracker } from "../cost/tracker.ts";
import type { Usage } from "../providers/types.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BudgetLimits {
  /** Hard ceiling on total USD spend. No limit when omitted. */
  readonly maxUsd?: number;
  /** Hard ceiling on total tokens (input + output + cache). No limit when omitted. */
  readonly maxTokens?: number;
}

export interface BudgetSnapshot {
  readonly usd: number;
  readonly tokens: number;
  readonly limits: BudgetLimits;
}

// ---------------------------------------------------------------------------
// Budget — immutable wrapper around CostTracker
// ---------------------------------------------------------------------------

export class Budget {
  private readonly limits: BudgetLimits;
  private readonly tracker: CostTracker;

  constructor(
    limits: BudgetLimits = {},
    tracker: CostTracker = new CostTracker(),
  ) {
    this.limits = limits;
    this.tracker = tracker;
  }

  /**
   * Return a NEW Budget with `usage` for `model` accumulated.
   * The original Budget instance is not modified.
   */
  record(model: string, usage: Usage): Budget {
    return new Budget(this.limits, this.tracker.add(model, usage));
  }

  /** Total USD spent so far. */
  spentUsd(): number {
    return this.tracker.total().usd;
  }

  /**
   * Total tokens spent so far (input + output + cache-read + cache-write).
   */
  spentTokens(): number {
    const { usage } = this.tracker.total();
    return (
      usage.inputTokens +
      usage.outputTokens +
      usage.cacheReadTokens +
      usage.cacheWriteTokens
    );
  }

  /**
   * USD still available before hitting `maxUsd`.
   * Returns `null` when no `maxUsd` limit is configured.
   */
  remainingUsd(): number | null {
    if (this.limits.maxUsd === undefined) return null;
    return this.limits.maxUsd - this.spentUsd();
  }

  /**
   * Tokens still available before hitting `maxTokens`.
   * Returns `null` when no `maxTokens` limit is configured.
   */
  remainingTokens(): number | null {
    if (this.limits.maxTokens === undefined) return null;
    return this.limits.maxTokens - this.spentTokens();
  }

  /**
   * Returns `true` when at least one limit is configured AND has been met or
   * exceeded. When no limits are set, always returns `false`.
   */
  exceeded(): boolean {
    const usdOver =
      this.limits.maxUsd !== undefined &&
      this.spentUsd() >= this.limits.maxUsd;
    const tokensOver =
      this.limits.maxTokens !== undefined &&
      this.spentTokens() >= this.limits.maxTokens;
    return usdOver || tokensOver;
  }

  /** Immutable point-in-time snapshot of spend and limits. */
  snapshot(): BudgetSnapshot {
    return {
      usd: this.spentUsd(),
      tokens: this.spentTokens(),
      limits: this.limits,
    };
  }
}
