/**
 * Tests for src/orchestrator/budget.ts — ADR 0001 §5 (token budget).
 */

import { describe, expect, test } from "bun:test";
import { Budget } from "../src/orchestrator/budget.ts";
import type { Usage } from "../src/providers/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USAGE_A: Usage = {
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 20,
  cacheWriteTokens: 10,
};
// total tokens USAGE_A = 180

const USAGE_B: Usage = {
  inputTokens: 200,
  outputTokens: 100,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
// total tokens USAGE_B = 300

const MODEL = "claude-haiku-4-5";

// ---------------------------------------------------------------------------
// Accumulation — immutability guarantee
// ---------------------------------------------------------------------------

describe("Budget.record — immutability", () => {
  test("original budget is not mutated after record()", () => {
    const original = new Budget();
    const next = original.record(MODEL, USAGE_A);

    expect(original.spentUsd()).toBe(0);
    expect(original.spentTokens()).toBe(0);
    expect(next.spentTokens()).toBe(180);
  });

  test("successive record() calls accumulate correctly", () => {
    const b0 = new Budget();
    const b1 = b0.record(MODEL, USAGE_A);
    const b2 = b1.record(MODEL, USAGE_B);

    // b1 unchanged
    expect(b1.spentTokens()).toBe(180);

    // b2 has both
    expect(b2.spentTokens()).toBe(180 + 300);
  });

  test("each call returns a distinct object", () => {
    const b0 = new Budget();
    const b1 = b0.record(MODEL, USAGE_A);
    expect(b1).not.toBe(b0);
  });
});

// ---------------------------------------------------------------------------
// spentUsd / spentTokens
// ---------------------------------------------------------------------------

describe("Budget.spentUsd / spentTokens", () => {
  test("fresh budget starts at zero", () => {
    const b = new Budget();
    expect(b.spentUsd()).toBe(0);
    expect(b.spentTokens()).toBe(0);
  });

  test("spentTokens sums all four token fields", () => {
    const b = new Budget().record(MODEL, USAGE_A);
    expect(b.spentTokens()).toBe(
      USAGE_A.inputTokens +
        USAGE_A.outputTokens +
        USAGE_A.cacheReadTokens +
        USAGE_A.cacheWriteTokens,
    );
  });

  test("spentUsd is positive after recording tokens", () => {
    const b = new Budget().record(MODEL, USAGE_A);
    expect(b.spentUsd()).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// remainingUsd / remainingTokens — with and without limits
// ---------------------------------------------------------------------------

describe("Budget.remainingUsd / remainingTokens", () => {
  test("returns null when no maxUsd limit is set", () => {
    const b = new Budget().record(MODEL, USAGE_A);
    expect(b.remainingUsd()).toBeNull();
  });

  test("returns null when no maxTokens limit is set", () => {
    const b = new Budget().record(MODEL, USAGE_A);
    expect(b.remainingTokens()).toBeNull();
  });

  test("remainingUsd decreases after recording usage", () => {
    const budget = new Budget({ maxUsd: 1.0 });
    const b = budget.record(MODEL, USAGE_A);
    const remaining = b.remainingUsd();
    expect(remaining).not.toBeNull();
    expect(remaining!).toBeLessThan(1.0);
    expect(remaining!).toBeCloseTo(1.0 - b.spentUsd(), 10);
  });

  test("remainingTokens decreases after recording usage", () => {
    const budget = new Budget({ maxTokens: 1000 });
    const b = budget.record(MODEL, USAGE_A);
    expect(b.remainingTokens()).toBe(1000 - 180);
  });

  test("remainingTokens can go negative when limit is exceeded", () => {
    const budget = new Budget({ maxTokens: 100 });
    const b = budget.record(MODEL, USAGE_A); // 180 tokens > 100 limit
    expect(b.remainingTokens()).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// exceeded()
// ---------------------------------------------------------------------------

describe("Budget.exceeded", () => {
  test("never exceeded when no limits are set", () => {
    const b = new Budget().record(MODEL, USAGE_A).record(MODEL, USAGE_B);
    expect(b.exceeded()).toBe(false);
  });

  test("not exceeded when under maxTokens limit", () => {
    const b = new Budget({ maxTokens: 10_000 }).record(MODEL, USAGE_A);
    expect(b.exceeded()).toBe(false);
  });

  test("exceeded when maxTokens is met exactly", () => {
    // USAGE_A = 180 tokens total
    const b = new Budget({ maxTokens: 180 }).record(MODEL, USAGE_A);
    expect(b.exceeded()).toBe(true);
  });

  test("exceeded when maxTokens is surpassed", () => {
    const b = new Budget({ maxTokens: 100 }).record(MODEL, USAGE_A); // 180 > 100
    expect(b.exceeded()).toBe(true);
  });

  test("exceeded when maxUsd is met", () => {
    // Record enough tokens that cost >= tiny limit
    const b = new Budget({ maxUsd: 0 }).record(MODEL, USAGE_A);
    expect(b.exceeded()).toBe(true);
  });

  test("exceeded when maxUsd is surpassed", () => {
    const b = new Budget({ maxUsd: 0.000001 }).record(MODEL, USAGE_A);
    expect(b.exceeded()).toBe(true);
  });

  test("not exceeded when only maxUsd set and under limit", () => {
    const b = new Budget({ maxUsd: 1000 }).record(MODEL, USAGE_A);
    expect(b.exceeded()).toBe(false);
  });

  test("exceeded when either limit is crossed (token breach only)", () => {
    // maxUsd is large, maxTokens is tiny
    const b = new Budget({ maxUsd: 1000, maxTokens: 10 }).record(MODEL, USAGE_A);
    expect(b.exceeded()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// snapshot()
// ---------------------------------------------------------------------------

describe("Budget.snapshot", () => {
  test("snapshot reflects current spend and configured limits", () => {
    const limits = { maxUsd: 5.0, maxTokens: 50_000 };
    const b = new Budget(limits).record(MODEL, USAGE_A);
    const snap = b.snapshot();

    expect(snap.usd).toBe(b.spentUsd());
    expect(snap.tokens).toBe(b.spentTokens());
    expect(snap.limits).toEqual(limits);
  });

  test("snapshot is a plain object (not Budget instance)", () => {
    const snap = new Budget().snapshot();
    expect(snap).not.toBeInstanceOf(Budget);
    expect(snap.usd).toBe(0);
    expect(snap.tokens).toBe(0);
  });
});
