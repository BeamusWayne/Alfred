import { test, expect, describe } from "bun:test";
import { isRetryable, computeDelay, retryAfterMs } from "../src/query/retry.ts";
import { ProviderError } from "../src/providers/types.ts";

describe("retry helpers", () => {
  test("isRetryable only for retryable ProviderError", () => {
    expect(isRetryable(new ProviderError("x", { retryable: true }))).toBe(true);
    expect(isRetryable(new ProviderError("x", { retryable: false }))).toBe(false);
    expect(isRetryable(new Error("x"))).toBe(false);
  });

  test("computeDelay prefers retryAfter", () => {
    expect(computeDelay(3, 1234)).toBe(1234);
  });

  test("computeDelay clamps an oversized retryAfter (no multi-hour stall)", () => {
    // A hostile/buggy endpoint sending Retry-After: 86400 must not stall for 24h.
    expect(computeDelay(1, 86_400_000)).toBe(60_000);
    expect(computeDelay(1, -5)).toBe(0); // never negative
  });

  test("computeDelay is exponential with no jitter (rand=0)", () => {
    expect(computeDelay(1, undefined, () => 0)).toBe(200);
    expect(computeDelay(2, undefined, () => 0)).toBe(400);
    expect(computeDelay(3, undefined, () => 0)).toBe(800);
  });

  test("computeDelay adds bounded jitter", () => {
    const d = computeDelay(1, undefined, () => 1);
    expect(d).toBeGreaterThanOrEqual(200);
    expect(d).toBeLessThanOrEqual(250);
  });

  test("retryAfterMs reads from ProviderError", () => {
    expect(retryAfterMs(new ProviderError("x", { retryAfterMs: 99 }))).toBe(99);
    expect(retryAfterMs(new Error("x"))).toBeUndefined();
  });
});
