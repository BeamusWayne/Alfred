/**
 * Tests for the Anthropic provider's error mapping (`toProviderError`).
 *
 * The contract the agent loop depends on: `ProviderError.retryable` must be
 * true ONLY for transient failures. A deterministic 4xx — most importantly an
 * invalid model name (400) — must be non-retryable so the loop fails fast
 * instead of replaying the identical request through the backoff budget.
 */
import { describe, test, expect } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { toProviderError } from "../src/providers/anthropic.ts";
import { ProviderError } from "../src/providers/types.ts";

/** Build a real SDK error subclass for `status` via the SDK's own factory. */
function apiError(status: number, message: string, headers?: Headers) {
  return Anthropic.APIError.generate(
    status,
    { error: { message } },
    message,
    headers ?? new Headers(),
  );
}

describe("toProviderError — retryable classification", () => {
  test("400 (e.g. invalid model) is NOT retryable and fails fast", () => {
    const e = toProviderError(apiError(400, "model: glm5 not found"));
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.status).toBe(400);
    expect(e.retryable).toBe(false);
    expect(e.message).toContain("glm5");
  });

  test("401 / 403 / 404 / 422 are not retryable", () => {
    for (const status of [401, 403, 404, 422]) {
      expect(toProviderError(apiError(status, "client error")).retryable).toBe(false);
    }
  });

  test("429 / 500 / 502 / 503 / 529 are retryable", () => {
    for (const status of [429, 500, 502, 503, 529]) {
      expect(toProviderError(apiError(status, "transient")).retryable).toBe(true);
    }
  });

  test("429 with a Retry-After header is parsed via Headers.get()", () => {
    const e = toProviderError(apiError(429, "slow down", new Headers({ "retry-after": "5" })));
    expect(e.retryable).toBe(true);
    expect(e.retryAfterMs).toBe(5000);
  });

  test("a non-numeric Retry-After does not yield a NaN delay", () => {
    const e = toProviderError(
      apiError(503, "unavailable", new Headers({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" })),
    );
    expect(e.retryAfterMs).toBeUndefined();
  });

  test("connection errors are retryable (transient network blip)", () => {
    const e = toProviderError(new Anthropic.APIConnectionError({ message: "socket hang up" }));
    expect(e.retryable).toBe(true);
    expect(e.status).toBeUndefined();
  });

  test("connection timeouts are retryable", () => {
    const e = toProviderError(new Anthropic.APIConnectionTimeoutError());
    expect(e.retryable).toBe(true);
  });

  test("a user abort is never retryable", () => {
    const e = toProviderError(new Anthropic.APIUserAbortError());
    expect(e.retryable).toBe(false);
  });

  test("a plain non-SDK error is a retryable blip unless it is an abort", () => {
    expect(toProviderError(new Error("ECONNRESET")).retryable).toBe(true);
    expect(toProviderError(new Error("The operation was aborted")).retryable).toBe(false);
  });
});
