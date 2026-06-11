/**
 * CLI plumbing for `alfred ledger verify` — locate the most recent run ledger
 * under `.alfred/workflows/` and render a verification outcome.
 *
 * The Proof Receipt story (ADR 0001 §5.3 + ADR 0004) only lands if checking a
 * receipt is one command: `alfred ledger verify` finds the latest run's
 * `ledger.jsonl`, recomputes the HMAC hash chain + signed head anchor, and
 * exits non-zero on the first broken row — suitable for CI and scripts.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Dev fallback shared with `alfred run` — override with ALFRED_LEDGER_SECRET. */
export const DEFAULT_LEDGER_SECRET = "alfred-dev-insecure-secret-change-me";

/**
 * Find the most recent `ledger.jsonl` under `<cwd>/.alfred/workflows/<runId>/`.
 * Run ids are ISO timestamps with `:`/`.` replaced by `-`, so reverse
 * lexicographic order is reverse chronological. Run directories without a
 * ledger are skipped. Returns null when nothing is found.
 */
export async function findLatestLedger(cwd: string): Promise<string | null> {
  const root = join(cwd, ".alfred", "workflows");
  let runIds: readonly string[];
  try {
    runIds = await readdir(root);
  } catch {
    return null; // no .alfred/workflows directory at all
  }
  const newestFirst = [...runIds].sort().reverse();
  for (const runId of newestFirst) {
    const candidate = join(root, runId, "ledger.jsonl");
    if (await Bun.file(candidate).exists()) return candidate;
  }
  return null;
}

/** Structural twin of `Ledger.verify()`'s return type. */
export type LedgerVerifyOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly brokenAt: number; readonly reason: string };

/** Render a verify outcome as a stable, grep-friendly CLI message. */
export function formatVerifyOutcome(
  path: string,
  rows: number,
  outcome: LedgerVerifyOutcome,
): string {
  if (outcome.ok) {
    const noun = rows === 1 ? "row" : "rows";
    return `✓ ledger intact — ${rows} ${noun}, hash chain + head anchor verified\n  ${path}`;
  }
  return `✗ TAMPER DETECTED at row ${outcome.brokenAt}: ${outcome.reason}\n  ${path}`;
}
