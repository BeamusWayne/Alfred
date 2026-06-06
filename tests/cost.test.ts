/**
 * Tests for src/cost/tracker.ts — ADR 0004.
 *
 * Covers:
 *   - Correct USD cost for known models (haiku, sonnet, opus).
 *   - Cache-read and cache-write tokens are priced correctly.
 *   - Unknown model id falls back to default pricing.
 *   - Immutability: add() returns a NEW tracker, original is unchanged.
 *   - total() aggregates across models.
 *   - byModel() returns a stable sorted list.
 *   - CostTracker.withPricing() allows custom pricing tables.
 */

import { describe, test, expect } from "bun:test";
import {
  CostTracker,
  PRICING_TABLE,
  type ModelPricing,
} from "../src/cost/tracker.ts";
import type { Usage } from "../src/providers/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function usage(
  inputTokens = 0,
  outputTokens = 0,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): Usage {
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

function approxEqual(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

// ---------------------------------------------------------------------------
// Pricing table sanity checks
// ---------------------------------------------------------------------------

describe("PRICING_TABLE", () => {
  test("contains the three required models", () => {
    expect(PRICING_TABLE["claude-haiku-4-5"]).toBeDefined();
    expect(PRICING_TABLE["claude-sonnet-4-6"]).toBeDefined();
    expect(PRICING_TABLE["claude-opus-4-8"]).toBeDefined();
  });

  test("all prices are positive numbers", () => {
    for (const [model, p] of Object.entries(PRICING_TABLE)) {
      expect(p.inputPerMillion).toBeGreaterThan(0);
      expect(p.outputPerMillion).toBeGreaterThan(0);
      expect(p.cacheReadPerMillion).toBeGreaterThan(0);
      expect(p.cacheWritePerMillion).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Cost math — known models
// ---------------------------------------------------------------------------

describe("CostTracker — known model pricing", () => {
  test("claude-haiku-4-5: 1M input tokens costs $0.80", () => {
    const t = new CostTracker().add("claude-haiku-4-5", usage(1_000_000));
    expect(approxEqual(t.total().usd, 0.80)).toBe(true);
  });

  test("claude-sonnet-4-6: 1M output tokens costs $15.00", () => {
    const t = new CostTracker().add("claude-sonnet-4-6", usage(0, 1_000_000));
    expect(approxEqual(t.total().usd, 15.00)).toBe(true);
  });

  test("claude-opus-4-8: 1M input + 1M output", () => {
    const t = new CostTracker().add(
      "claude-opus-4-8",
      usage(1_000_000, 1_000_000),
    );
    // 15 (input) + 75 (output) = $90
    expect(approxEqual(t.total().usd, 90.00)).toBe(true);
  });

  test("haiku cache-read tokens priced at $0.08/M", () => {
    const t = new CostTracker().add(
      "claude-haiku-4-5",
      usage(0, 0, 1_000_000, 0),
    );
    expect(approxEqual(t.total().usd, 0.08)).toBe(true);
  });

  test("haiku cache-write tokens priced at $1.00/M", () => {
    const t = new CostTracker().add(
      "claude-haiku-4-5",
      usage(0, 0, 0, 1_000_000),
    );
    expect(approxEqual(t.total().usd, 1.00)).toBe(true);
  });

  test("sonnet cache-read tokens priced at $0.30/M", () => {
    const t = new CostTracker().add(
      "claude-sonnet-4-6",
      usage(0, 0, 1_000_000, 0),
    );
    expect(approxEqual(t.total().usd, 0.30)).toBe(true);
  });

  test("opus cache-write tokens priced at $18.75/M", () => {
    const t = new CostTracker().add(
      "claude-opus-4-8",
      usage(0, 0, 0, 1_000_000),
    );
    expect(approxEqual(t.total().usd, 18.75)).toBe(true);
  });

  test("combined usage across all token types for sonnet", () => {
    // 100k input + 50k output + 200k cache-read + 10k cache-write
    const t = new CostTracker().add(
      "claude-sonnet-4-6",
      usage(100_000, 50_000, 200_000, 10_000),
    );
    const p = PRICING_TABLE["claude-sonnet-4-6"]!;
    const expected =
      (100_000 * p.inputPerMillion) / 1_000_000 +
      (50_000 * p.outputPerMillion) / 1_000_000 +
      (200_000 * p.cacheReadPerMillion) / 1_000_000 +
      (10_000 * p.cacheWritePerMillion) / 1_000_000;
    expect(approxEqual(t.total().usd, expected)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unknown model fallback
// ---------------------------------------------------------------------------

describe("CostTracker — unknown model fallback", () => {
  test("unknown model falls back to default pricing (sonnet rates)", () => {
    const t = new CostTracker().add("gpt-unknown-9000", usage(1_000_000));
    // Default is sonnet-level: $3.00/M input
    expect(approxEqual(t.total().usd, 3.00)).toBe(true);
  });

  test("unknown model output tokens use default output rate", () => {
    const t = new CostTracker().add("gpt-unknown-9000", usage(0, 1_000_000));
    expect(approxEqual(t.total().usd, 15.00)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------

describe("CostTracker — immutability", () => {
  test("add() returns a new tracker, original has zero cost", () => {
    const original = new CostTracker();
    const next = original.add("claude-sonnet-4-6", usage(1_000_000));

    expect(original.total().usd).toBe(0);
    expect(next.total().usd).toBeGreaterThan(0);
  });

  test("chaining add() produces independent snapshots", () => {
    const t0 = new CostTracker();
    const t1 = t0.add("claude-haiku-4-5", usage(1_000_000));
    const t2 = t1.add("claude-haiku-4-5", usage(1_000_000));

    // t0 untouched
    expect(t0.total().usd).toBe(0);
    // t1 has 1M tokens
    expect(approxEqual(t1.total().usd, 0.80)).toBe(true);
    // t2 has 2M tokens
    expect(approxEqual(t2.total().usd, 1.60)).toBe(true);
  });

  test("add() for same model accumulates usage in new tracker", () => {
    const t1 = new CostTracker().add("claude-opus-4-8", usage(500_000));
    const t2 = t1.add("claude-opus-4-8", usage(500_000));

    // Combined: 1M input tokens at opus rate ($15)
    expect(approxEqual(t2.total().usd, 15.00)).toBe(true);
    // t1 is half that
    expect(approxEqual(t1.total().usd, 7.50)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// total() aggregation
// ---------------------------------------------------------------------------

describe("CostTracker — total()", () => {
  test("total() aggregates USD across multiple models", () => {
    const t = new CostTracker()
      .add("claude-haiku-4-5", usage(1_000_000))      // $0.80
      .add("claude-sonnet-4-6", usage(1_000_000));    // $3.00
    expect(approxEqual(t.total().usd, 3.80)).toBe(true);
  });

  test("total() aggregates Usage across multiple models", () => {
    const t = new CostTracker()
      .add("claude-haiku-4-5", usage(100, 200))
      .add("claude-sonnet-4-6", usage(300, 400));
    const { usage: agg } = t.total();
    expect(agg.inputTokens).toBe(400);
    expect(agg.outputTokens).toBe(600);
  });

  test("total() on empty tracker returns 0 usd", () => {
    const t = new CostTracker();
    expect(t.total().usd).toBe(0);
    expect(t.total().usage.inputTokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// byModel()
// ---------------------------------------------------------------------------

describe("CostTracker — byModel()", () => {
  test("returns one record per distinct model", () => {
    const t = new CostTracker()
      .add("claude-sonnet-4-6", usage(1_000_000))
      .add("claude-haiku-4-5", usage(1_000_000))
      .add("claude-sonnet-4-6", usage(500_000));

    const records = t.byModel();
    expect(records.length).toBe(2);
  });

  test("records are sorted alphabetically by model name", () => {
    const t = new CostTracker()
      .add("claude-sonnet-4-6", usage(1))
      .add("claude-opus-4-8", usage(1))
      .add("claude-haiku-4-5", usage(1));

    const names = t.byModel().map((r) => r.model);
    expect(names).toEqual([...names].sort());
  });

  test("each record has correct accumulated usage", () => {
    const t = new CostTracker()
      .add("claude-haiku-4-5", usage(100, 50))
      .add("claude-haiku-4-5", usage(200, 75));

    const [rec] = t.byModel();
    expect(rec!.usage.inputTokens).toBe(300);
    expect(rec!.usage.outputTokens).toBe(125);
  });
});

// ---------------------------------------------------------------------------
// withPricing() — custom table
// ---------------------------------------------------------------------------

describe("CostTracker.withPricing()", () => {
  test("uses custom pricing for a known model", () => {
    const customTable: Readonly<Record<string, ModelPricing>> = {
      "my-model": {
        inputPerMillion: 1.00,
        outputPerMillion: 2.00,
        cacheReadPerMillion: 0.10,
        cacheWritePerMillion: 0.50,
      },
    };
    const t = CostTracker.withPricing(customTable).add(
      "my-model",
      usage(1_000_000),
    );
    expect(approxEqual(t.total().usd, 1.00)).toBe(true);
  });

  test("custom table still falls back to default for unknown models", () => {
    const t = CostTracker.withPricing({}).add(
      "some-unknown-model",
      usage(1_000_000),
    );
    // Falls back to default ($3.00/M)
    expect(approxEqual(t.total().usd, 3.00)).toBe(true);
  });
});
