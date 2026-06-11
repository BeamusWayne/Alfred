/**
 * Token-cost accounting for Alfred — ADR 0004.
 *
 * Maintains an immutable accumulator of per-model token usage and converts it
 * to USD using a pricing table keyed by model id. `CostTracker.add()` always
 * returns a NEW tracker, preserving the immutability contract.
 *
 * The exported `PRICING_TABLE` constant is the single source of truth for
 * model costs and can be patched in tests or extended at runtime without
 * mutating the original.
 */

import type { Usage } from "../providers/types.ts";
import { addUsage, ZERO_USAGE } from "../providers/types.ts";

// ---------------------------------------------------------------------------
// Pricing table — USD per 1 million tokens
// ---------------------------------------------------------------------------

export interface ModelPricing {
  /** USD per 1M input (uncached) tokens. */
  readonly inputPerMillion: number;
  /** USD per 1M output tokens. */
  readonly outputPerMillion: number;
  /** USD per 1M cache-read tokens. */
  readonly cacheReadPerMillion: number;
  /** USD per 1M cache-write tokens. */
  readonly cacheWritePerMillion: number;
}

/**
 * Pricing table keyed by model id.  All prices are USD per 1 million tokens.
 * Sources: Anthropic public pricing page (as of 2025-06).
 *
 * Exported so callers can extend or override without mutating this object —
 * spread a new table: `{ ...PRICING_TABLE, "my-model": { ... } }`.
 */
export const PRICING_TABLE: Readonly<Record<string, ModelPricing>> = {
  "claude-fable-5": {
    inputPerMillion: 10.0,
    outputPerMillion: 50.0,
    cacheReadPerMillion: 1.0,
    cacheWritePerMillion: 12.5,
  },
  "claude-haiku-4-5": {
    inputPerMillion: 1.0,
    outputPerMillion: 5.0,
    cacheReadPerMillion: 0.1,
    cacheWritePerMillion: 1.25,
  },
  "claude-sonnet-4-6": {
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  },
  "claude-opus-4-6": {
    inputPerMillion: 5.0,
    outputPerMillion: 25.0,
    cacheReadPerMillion: 0.5,
    cacheWritePerMillion: 6.25,
  },
  "claude-opus-4-7": {
    inputPerMillion: 5.0,
    outputPerMillion: 25.0,
    cacheReadPerMillion: 0.5,
    cacheWritePerMillion: 6.25,
  },
  "claude-opus-4-8": {
    inputPerMillion: 5.0,
    outputPerMillion: 25.0,
    cacheReadPerMillion: 0.5,
    cacheWritePerMillion: 6.25,
  },
  // Zhipu GLM — approximate public pricing (USD per 1M tokens).
  "glm-4.5": {
    inputPerMillion: 0.6,
    outputPerMillion: 2.2,
    cacheReadPerMillion: 0.11,
    cacheWritePerMillion: 0.75,
  },
  "glm-4.6": {
    inputPerMillion: 0.6,
    outputPerMillion: 2.2,
    cacheReadPerMillion: 0.11,
    cacheWritePerMillion: 0.75,
  },
  "glm-5.1": {
    inputPerMillion: 0.6,
    outputPerMillion: 2.2,
    cacheReadPerMillion: 0.11,
    cacheWritePerMillion: 0.75,
  },
  // Google Gemini — approximate public pricing (USD per 1M tokens).
  "gemini-2.5-flash": {
    inputPerMillion: 0.3,
    outputPerMillion: 2.5,
    cacheReadPerMillion: 0.075,
    cacheWritePerMillion: 0.3,
  },
  "gemini-2.5-pro": {
    inputPerMillion: 1.25,
    outputPerMillion: 10.0,
    cacheReadPerMillion: 0.31,
    cacheWritePerMillion: 1.25,
  },
  "gemini-2.0-flash": {
    inputPerMillion: 0.1,
    outputPerMillion: 0.4,
    cacheReadPerMillion: 0.025,
    cacheWritePerMillion: 0.1,
  },
};

/** Fallback pricing applied to unrecognised model ids. */
const DEFAULT_PRICING: ModelPricing = {
  inputPerMillion: 3.0,
  outputPerMillion: 15.0,
  cacheReadPerMillion: 0.3,
  cacheWritePerMillion: 3.75,
};

function pricingFor(model: string, table: Readonly<Record<string, ModelPricing>>): ModelPricing {
  return table[model] ?? DEFAULT_PRICING;
}

function computeCost(usage: Usage, pricing: ModelPricing): number {
  return (
    (usage.inputTokens * pricing.inputPerMillion) / 1_000_000 +
    (usage.outputTokens * pricing.outputPerMillion) / 1_000_000 +
    (usage.cacheReadTokens * pricing.cacheReadPerMillion) / 1_000_000 +
    (usage.cacheWriteTokens * pricing.cacheWritePerMillion) / 1_000_000
  );
}

// ---------------------------------------------------------------------------
// Per-model record (immutable)
// ---------------------------------------------------------------------------

export interface ModelRecord {
  readonly model: string;
  readonly usage: Usage;
  readonly usd: number;
}

// ---------------------------------------------------------------------------
// CostTracker — immutable accumulator
// ---------------------------------------------------------------------------

export class CostTracker {
  /**
   * Internal per-model accumulation map. Never mutated after construction;
   * `add()` returns a brand-new instance.
   */
  private readonly records: ReadonlyMap<string, ModelRecord>;
  private readonly table: Readonly<Record<string, ModelPricing>>;

  constructor(
    records: ReadonlyMap<string, ModelRecord> = new Map(),
    table: Readonly<Record<string, ModelPricing>> = PRICING_TABLE,
  ) {
    this.records = records;
    this.table = table;
  }

  /**
   * Return a NEW CostTracker with `usage` accumulated under `model`.
   * The original tracker is not modified.
   */
  add(model: string, usage: Usage): CostTracker {
    const existing = this.records.get(model);
    const mergedUsage = existing ? addUsage(existing.usage, usage) : usage;
    const pricing = pricingFor(model, this.table);
    const usd = computeCost(mergedUsage, pricing);
    const updated: ModelRecord = { model, usage: mergedUsage, usd };
    const next = new Map(this.records);
    next.set(model, updated);
    return new CostTracker(next, this.table);
  }

  /**
   * Aggregate totals across all models.
   */
  total(): { readonly usd: number; readonly usage: Usage } {
    let usd = 0;
    let usage: Usage = ZERO_USAGE;
    for (const record of this.records.values()) {
      usd += record.usd;
      usage = addUsage(usage, record.usage);
    }
    return { usd, usage };
  }

  /**
   * Per-model breakdown sorted by model name for stable output.
   */
  byModel(): readonly ModelRecord[] {
    return [...this.records.values()].sort((a, b) => a.model.localeCompare(b.model));
  }

  /**
   * Convenience factory: build a tracker that uses a custom pricing table
   * (useful in tests or when integrating a newer model).
   */
  static withPricing(table: Readonly<Record<string, ModelPricing>>): CostTracker {
    return new CostTracker(new Map(), table);
  }
}
