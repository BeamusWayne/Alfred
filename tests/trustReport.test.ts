/**
 * Trust Report v0 emitter tests — a real signed ledger mapped onto the
 * cross-tool report shape (spec: BeamusWayne/agent-trust-layer).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/orchestrator/ledger.ts";
import { toTrustReport } from "../src/orchestrator/trustReport.ts";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "alfred-trust-report-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const SECRET = "test-secret";
const NOW = () => new Date("2026-06-13T00:00:00.000Z");

async function buildLedger(name: string): Promise<Ledger> {
  const ledger = new Ledger(join(tmpDir, name, "ledger.jsonl"), SECRET);
  await ledger.append("run_start", { runId: name });
  await ledger.append("feature", { feature: "feat-1", status: "passing", verifyExit: 0 });
  await ledger.append("feature", { feature: "feat-2", status: "blocked", verifyExit: 1 });
  await ledger.append("run_end", { passing: 1, blocked: 1, stopped: "all_resolved" });
  return ledger;
}

describe("toTrustReport (alfred)", () => {
  test("intact chain with a blocked feature → pass chain, warn outcome", async () => {
    const ledger = await buildLedger("run-a");
    const entries = await ledger.readAll();
    const outcome = await ledger.verify();

    const report = toTrustReport({
      outcome,
      entries,
      runId: "run-a",
      version: "0.7.0",
      now: NOW,
    });

    expect(report.trust_report_version).toBe("0");
    expect(report.producer).toEqual({ name: "alfred", version: "0.7.0" });
    expect(report.subject).toEqual({ kind: "run", id: "run-a" });
    expect(report.checks.find((c) => c.id === "ledger.chain")?.verdict).toBe("pass");
    expect(report.checks.find((c) => c.id === "gate.verify")?.verdict).toBe("pass");
    expect(report.checks.find((c) => c.id === "run.outcome")?.verdict).toBe("warn");
    expect(report.verdict).toBe("warn");
    expect(report.generated_at).toBe("2026-06-13T00:00:00.000Z");
  });

  test("a tampered chain fails and suppresses downstream checks", async () => {
    const ledger = await buildLedger("run-b");
    const entries = await ledger.readAll();
    // Tamper: a payload that no longer matches its HMAC signature.
    const tampered = entries.map((e, i) =>
      i === 1 ? { ...e, data: { ...e.data, status: "passing", verifyExit: 0, forged: true } } : e,
    );

    const report = toTrustReport({
      outcome: { ok: false, brokenAt: 1, reason: "HMAC mismatch at seq 1" },
      entries: tampered,
      runId: "run-b",
      version: "0.7.0",
      now: NOW,
    });

    expect(report.verdict).toBe("fail");
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]?.id).toBe("ledger.chain");
    expect(report.checks[0]?.detail).toContain("row 1");
  });

  test("a passing feature without verify exit 0 fails gate.verify", async () => {
    const ledger = new Ledger(join(tmpDir, "run-c", "ledger.jsonl"), SECRET);
    await ledger.append("feature", { feature: "feat-x", status: "passing", verifyExit: 1 });
    const entries = await ledger.readAll();
    const outcome = await ledger.verify();

    const report = toTrustReport({ outcome, entries, runId: "run-c", version: "0.7.0", now: NOW });

    const gate = report.checks.find((c) => c.id === "gate.verify");
    expect(gate?.verdict).toBe("fail");
    expect(gate?.detail).toContain("feat-x");
    expect(report.verdict).toBe("fail");
  });
});
