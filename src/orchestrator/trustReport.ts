/**
 * Agent Trust Report v0 — the cross-tool verdict format of the trust layer.
 *
 * One schema, three producers: Alfred (`ledger verify --trust-report`)
 * reports on a signed run receipt, NightWatch (`attest --trust-report`) on a
 * recorded session, trace-vault (`vault gate --trust-report`) on a replay
 * suite. CI consumes the same `{verdict, checks[]}` regardless of which tool
 * produced it — spec: https://github.com/BeamusWayne/agent-trust-layer
 */

import type { LedgerEntry } from "./ledger.ts";
import type { LedgerVerifyOutcome } from "./ledgerLocate.ts";

export type TrustVerdict = "pass" | "warn" | "fail";

export interface TrustCheck {
  /** Stable dotted id, e.g. `ledger.chain`, `gate.verify`. */
  readonly id: string;
  readonly verdict: TrustVerdict;
  readonly detail: string;
}

export interface TrustReport {
  readonly trust_report_version: "0";
  readonly producer: { readonly name: string; readonly version: string };
  readonly subject: { readonly kind: "session" | "run" | "suite"; readonly id: string };
  readonly verdict: TrustVerdict;
  readonly checks: readonly TrustCheck[];
  readonly generated_at: string;
}

function worst(verdicts: readonly TrustVerdict[]): TrustVerdict {
  if (verdicts.includes("fail")) return "fail";
  if (verdicts.includes("warn")) return "warn";
  return "pass";
}

function chainCheck(outcome: LedgerVerifyOutcome, rows: number): TrustCheck {
  return outcome.ok
    ? {
        id: "ledger.chain",
        verdict: "pass",
        detail: `HMAC hash chain + signed head anchor intact (${rows} rows)`,
      }
    : {
        id: "ledger.chain",
        verdict: "fail",
        detail: `TAMPERED at row ${outcome.brokenAt}: ${outcome.reason}`,
      };
}

function verifyGateCheck(entries: readonly LedgerEntry[]): TrustCheck | null {
  const features = entries.filter((e) => e.kind === "feature");
  if (features.length === 0) return null;
  // A "passing" row whose recorded verify exit is non-zero means the receipt
  // contradicts itself — exactly what this check exists to catch.
  const inconsistent = features.filter(
    (e) => e.data["status"] === "passing" && e.data["verifyExit"] !== 0,
  );
  if (inconsistent.length > 0) {
    const ids = inconsistent.map((e) => String(e.data["feature"])).join(", ");
    return {
      id: "gate.verify",
      verdict: "fail",
      detail: `feature(s) marked passing without verify exit 0: ${ids}`,
    };
  }
  const passing = features.filter((e) => e.data["status"] === "passing").length;
  return {
    id: "gate.verify",
    verdict: "pass",
    detail: `${passing}/${features.length} feature(s) passed the machine verify gate (exit 0)`,
  };
}

function runOutcomeCheck(entries: readonly LedgerEntry[]): TrustCheck {
  const end = [...entries].reverse().find((e) => e.kind === "run_end");
  if (end === undefined) {
    return {
      id: "run.outcome",
      verdict: "warn",
      detail: "no run_end row — the run was interrupted or is still in flight",
    };
  }
  const passing = Number(end.data["passing"] ?? 0);
  const blocked = Number(end.data["blocked"] ?? 0);
  const stopped = String(end.data["stopped"] ?? "unknown");
  const detail = `${passing} passing · ${blocked} blocked · stopped: ${stopped}`;
  return blocked === 0 && stopped === "all_resolved"
    ? { id: "run.outcome", verdict: "pass", detail }
    : { id: "run.outcome", verdict: "warn", detail };
}

export interface TrustReportInput {
  readonly outcome: LedgerVerifyOutcome;
  readonly entries: readonly LedgerEntry[];
  readonly runId: string;
  readonly version: string;
  readonly now?: () => Date;
}

/** Map a verified run receipt onto the cross-tool Trust Report v0 shape. */
export function toTrustReport(input: TrustReportInput): TrustReport {
  const checks: TrustCheck[] = [chainCheck(input.outcome, input.entries.length)];
  // A tampered chain poisons every downstream claim — report only the tamper.
  if (input.outcome.ok) {
    const gate = verifyGateCheck(input.entries);
    if (gate !== null) checks.push(gate);
    checks.push(runOutcomeCheck(input.entries));
  }

  return {
    trust_report_version: "0",
    producer: { name: "alfred", version: input.version },
    subject: { kind: "run", id: input.runId },
    verdict: worst(checks.map((c) => c.verdict)),
    checks,
    generated_at: (input.now ?? (() => new Date()))().toISOString(),
  };
}
