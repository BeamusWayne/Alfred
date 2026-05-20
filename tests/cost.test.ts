import { describe, test, expect, beforeEach } from "bun:test";
import { CostTracker, MODEL_PRICING, resetCostTracker, getSessionCosts, formatCost } from "../src/cost/tracker.js";

describe("cost tracker", () => {
  beforeEach(() => {
    resetCostTracker();
  });

  test("track input tokens", () => {
    const tracker = new CostTracker();
    tracker.addUsage("claude-sonnet-4-6", { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const costs = tracker.getCosts();
    expect(costs.totalInputTokens).toBe(1000);
  });

  test("track output tokens", () => {
    const tracker = new CostTracker();
    tracker.addUsage("claude-sonnet-4-6", { inputTokens: 0, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const costs = tracker.getCosts();
    expect(costs.totalOutputTokens).toBe(500);
  });

  test("calculate cost for Sonnet", () => {
    const tracker = new CostTracker();
    tracker.addUsage("claude-sonnet-4-6", { inputTokens: 1000000, outputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const costs = tracker.getCosts();
    // Sonnet: $3/M input, $15/M output
    expect(costs.totalCost).toBeCloseTo(18.0, 2);
  });

  test("calculate cost with cache", () => {
    const tracker = new CostTracker();
    tracker.addUsage("claude-sonnet-4-6", { inputTokens: 500000, outputTokens: 0, cacheReadTokens: 500000, cacheWriteTokens: 0 });
    const costs = tracker.getCosts();
    // Sonnet: $3/M input + $0.30/M cache read = 1.5 + 0.15 = 1.65
    expect(costs.totalCost).toBeCloseTo(1.65, 2);
  });

  test("accumulate across multiple calls", () => {
    const tracker = new CostTracker();
    tracker.addUsage("claude-sonnet-4-6", { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 });
    tracker.addUsage("claude-sonnet-4-6", { inputTokens: 2000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const costs = tracker.getCosts();
    expect(costs.totalInputTokens).toBe(3000);
    expect(costs.totalOutputTokens).toBe(1500);
  });

  test("unknown model uses default pricing", () => {
    const tracker = new CostTracker();
    tracker.addUsage("unknown-model", { inputTokens: 1000000, outputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const costs = tracker.getCosts();
    // Default: $3/M input, $15/M output
    expect(costs.totalCost).toBeCloseTo(18.0, 2);
  });

  test("format cost as USD string", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(1.5)).toBe("$1.50");
    expect(formatCost(0.003)).toBe("$0.00");
    expect(formatCost(1234.567)).toBe("$1234.57");
  });

  test("global session costs", () => {
    resetCostTracker();
    const tracker = new CostTracker();
    tracker.addUsage("claude-sonnet-4-6", { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const session = getSessionCosts();
    expect(session.totalInputTokens).toBe(1000000);
  });
});

describe("model pricing", () => {
  test("has pricing for known models", () => {
    expect(MODEL_PRICING["claude-sonnet-4-6"]).toBeDefined();
    expect(MODEL_PRICING["claude-opus-4-7"]).toBeDefined();
    expect(MODEL_PRICING["claude-haiku-4-5"]).toBeDefined();
  });

  test("pricing has required fields", () => {
    const sonnet = MODEL_PRICING["claude-sonnet-4-6"];
    expect(sonnet.inputPerMillion).toBeGreaterThan(0);
    expect(sonnet.outputPerMillion).toBeGreaterThan(0);
    expect(sonnet.cacheReadPerMillion).toBeGreaterThan(0);
  });
});
