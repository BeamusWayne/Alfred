/**
 * Ctrl-C truthfulness: an operator interrupt must STOP the autonomous run,
 * not grind through dead-signal attempts and fabricate a "blocked" receipt.
 * Observed live (run 2026-06-11T09-03): after a mid-implement SIGINT the
 * harness ran two more 1-turn aborted attempts, an aborted rubric, marked
 * the feature blocked with `verify exit 1`, and signed `all_resolved`.
 *
 * Contract under test: on abort, the in-flight feature reverts to pending,
 * NO feature row is signed, and run_end records stopped="aborted".
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFeatureList } from "../src/harness/featureList.ts";
import { Journal } from "../src/orchestrator/journal.ts";
import { Ledger } from "../src/orchestrator/ledger.ts";
import { createRuntime } from "../src/orchestrator/runtime.ts";
import {
  type AutonomousEvent,
  autonomousRun,
} from "../src/orchestrator/workflows/autonomousRun.ts";
import type { ToolPermissionContext } from "../src/permissions/types.ts";
import { MockProvider, textResponse } from "../src/providers/mock.ts";

function perms(dir: string): ToolPermissionContext {
  return { mode: "bypass", allowedTools: new Set(), deniedTools: new Set(), workingDir: dir };
}

describe("autonomousRun — abort semantics", () => {
  test("an interrupt stops the run: feature back to pending, truthful run_end, no fake receipt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alfred-abort-"));
    const featureListPath = join(dir, "fl.json");
    await Bun.write(
      featureListPath,
      JSON.stringify({
        features: [
          { id: "f1", title: "F1", description: "do x", status: "pending", iterationBudget: 3 },
        ],
      }),
    );

    const controller = new AbortController();
    // The "user" hits Ctrl-C while the first implement turn is in flight.
    const provider = new MockProvider([
      () => {
        controller.abort();
        return textResponse("interrupted mid-implement");
      },
    ]);
    const journal = new Journal(join(dir, "j.jsonl"));
    const ledger = new Ledger(join(dir, "l.jsonl"), "s");
    const runtime = createRuntime("t", {
      provider,
      model: "base",
      permissions: perms(dir),
      journal,
      signal: controller.signal,
    });
    const events: AutonomousEvent[] = [];

    const result = await autonomousRun({
      runtime,
      ledger,
      cwd: dir,
      featureListPath,
      verifyCmd: "false", // must never run after the abort — and can never pass
      signal: controller.signal,
      onEvent: (ev) => events.push(ev),
    });

    expect(result.stopped).toBe("aborted");
    expect(result.passing).toBe(0);
    expect(result.blocked).toBe(0);

    // The interrupted feature is pending again — rerunnable, not "blocked".
    const list = await loadFeatureList(featureListPath);
    expect(list.features[0]?.status).toBe("pending");

    // The receipt records the truth: a run_end with stopped=aborted and NO
    // fabricated feature row.
    const rows = await ledger.readAll();
    expect(rows.map((r) => r.kind)).toEqual(["run_end"]);
    expect(rows[0]?.data["stopped"]).toBe("aborted");

    // No feature_blocked event was emitted for the interrupt.
    expect(events.some((e) => e.type === "feature_blocked")).toBe(false);
  });

  test("an abort before the run starts resolves zero features without receipts rows for them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alfred-abort-"));
    const featureListPath = join(dir, "fl.json");
    await Bun.write(
      featureListPath,
      JSON.stringify({
        features: [{ id: "f1", title: "F1", description: "do x", status: "pending" }],
      }),
    );

    const controller = new AbortController();
    controller.abort(); // already dead at entry
    const provider = new MockProvider([textResponse("never consumed")]);
    const ledger = new Ledger(join(dir, "l.jsonl"), "s");
    const runtime = createRuntime("t", {
      provider,
      model: "base",
      permissions: perms(dir),
      signal: controller.signal,
    });

    const result = await autonomousRun({
      runtime,
      ledger,
      cwd: dir,
      featureListPath,
      verifyCmd: "false",
      signal: controller.signal,
    });

    expect(result.stopped).toBe("aborted");
    expect((await ledger.readAll()).map((r) => r.kind)).toEqual(["run_end"]);
    expect((await loadFeatureList(featureListPath)).features[0]?.status).toBe("pending");
  });
});
