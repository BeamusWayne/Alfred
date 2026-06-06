/**
 * Retry primitives for transient provider failures (ADR 0001 §1 / review R1.1).
 * Pure, testable helpers; the engine drives the loop so it can yield
 * `retrying` events. Backoff is exponential with jitter and prefers a server
 * `Retry-After` when present.
 */
import { ProviderError } from "../providers/types.ts";

export function isRetryable(err: unknown): boolean {
  return err instanceof ProviderError && err.retryable;
}

export function retryAfterMs(err: unknown): number | undefined {
  return err instanceof ProviderError ? err.retryAfterMs : undefined;
}

/** Delay before attempt N (1-based). Prefers `retryAfter`, else 200·2^(n-1) + jitter. */
export function computeDelay(
  attempt: number,
  retryAfter?: number,
  rand: () => number = Math.random,
): number {
  if (retryAfter !== undefined) return retryAfter;
  const base = 200 * 2 ** (attempt - 1);
  return Math.round(base + base * 0.25 * rand());
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
