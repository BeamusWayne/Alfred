/**
 * Fast verify pre-gate (--verify-fast): a cheap failure signal short-circuits
 * the fix loop; ONLY the full gate's exit 0 can mark a feature passing.
 */
import { test, expect, describe } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autonomousRun, type AutonomousEvent } from "../src/orchestrator/workflows/autonomousRun.ts";
import { createRuntime } from "../src/orchestrator/runtime.ts";
import { Journal } from "../src/orchestrator/journal.ts";
import { Ledger } from "../src/orchestrator/ledger.ts";
import { MockProvider, textResponse, toolUseResponse, type Script } from "../src/providers/mock.ts";
import type { ToolPermissionContext } from "../src/permissions/types.ts";

function perms(dir: string): ToolPermissionContext {
  return { mode: "bypass", allowedTools: new Set(), deniedTools: new Set(), workingDir: dir };
}

/** Implement turns return text; rubric turns emit the structured verdict. */
function harnessScript(verification: number): Script {
  return (messages) => {
    const firstUser = messages.find((m) => m.role === "user");
    const t = firstUser && typeof firstUser.content === "string" ? firstUser.content : "";
    const last = messages[messages.length - 1];
    if (t.includes("Assess whether")) {
      return last && last.role === "tool_result"
        ? textResponse("done")
        : toolUseResponse("structured_output", { verification, reasoning: "checked" });
    }
    return textResponse("implemented");
  };
}

async function run(dir: string, opts: { fast?: string; full: string; budget?: number; verification?: number }) {
  await Bun.write(
    join(dir, "fl.json"),
    JSON.stringify({
      features: [
        {
          id: "f1",
          title: "F1",
          description: "do x",
          status: "pending",
          iterationBudget: opts.budget ?? 2,
        },
      ],
    }),
  );
  const provider = new MockProvider([harnessScript(opts.verification ?? 2)]);
  const journal = new Journal(join(dir, "j.jsonl"));
  const ledger = new Ledger(join(dir, "l.jsonl"), "s");
  const runtime = createRuntime("t", { provider, model: "base", permissions: perms(dir), journal });
  const events: AutonomousEvent[] = [];
  const result = await autonomousRun({
    runtime,
    ledger,
    cwd: dir,
    featureListPath: join(dir, "fl.json"),
    verifyCmd: opts.full,
    fastVerifyCmd: opts.fast,
    onEvent: (e) => events.push(e),
  });
  await journal.close();
  return { result, events };
}

const verifyEvents = (events: AutonomousEvent[]) =>
  events.filter((e): e is Extract<AutonomousEvent, { type: "verify" }> => e.type === "verify");

describe("fast verify pre-gate", () => {
  test("fast failure short-circuits without running the full suite; retry passes both", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alfred-fast-"));
    // Fast gate: fails on the first run, passes from the second on.
    const fast = `c=$(cat fast.txt 2>/dev/null || echo 0); c=$((c+1)); printf %s "$c" > fast.txt; [ "$c" -ge 2 ]`;
    const full = `printf x >> full.txt; exit 0`;
    const { result, events } = await run(dir, { fast, full });

    expect(result.passing).toBe(1);
    const v = verifyEvents(events);
    expect(v.map((e) => `${e.gate}:${e.passed}`)).toEqual(["fast:false", "fast:true", "full:true"]);
    // The full suite ran exactly once — the fast failure never reached it.
    expect(await Bun.file(join(dir, "full.txt")).text()).toBe("x");
  });

  test("fast pass can NOT mark a feature passing — the full gate stays authoritative", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alfred-fastauth-"));
    const { result, events } = await run(dir, {
      fast: "exit 0",
      full: "exit 1",
      budget: 1,
      verification: 0,
    });
    expect(result.passing).toBe(0);
    expect(result.blocked).toBe(1);
    const v = verifyEvents(events);
    expect(v.map((e) => `${e.gate}:${e.passed}`)).toEqual(["fast:true", "full:false"]);
  });

  test("without a fast cmd the behaviour is unchanged (full gate only)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alfred-nofast-"));
    const { result, events } = await run(dir, { full: "exit 0", budget: 1 });
    expect(result.passing).toBe(1);
    expect(verifyEvents(events).map((e) => e.gate)).toEqual(["full"]);
  });
});

describe("rubric evidence access", () => {
  test("the judge gets read-only tools alongside structured_output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alfred-rubric-"));
    await Bun.write(
      join(dir, "fl.json"),
      JSON.stringify({
        features: [
          { id: "f1", title: "F1", description: "do x", status: "pending", iterationBudget: 1 },
        ],
      }),
    );
    const provider = new MockProvider([harnessScript(2)]);
    const journal = new Journal(join(dir, "j.jsonl"));
    const ledger = new Ledger(join(dir, "l.jsonl"), "s");
    const runtime = createRuntime("t", { provider, model: "base", permissions: perms(dir), journal });
    await autonomousRun({
      runtime,
      ledger,
      cwd: dir,
      featureListPath: join(dir, "fl.json"),
      verifyCmd: "exit 0",
    });
    await journal.close();
    // The rubric call is the last chat: implement (call 0), rubric (call 1+).
    const rubricTools = provider.toolNames[provider.toolNames.length - 1] ?? [];
    expect(rubricTools).toContain("structured_output");
    expect(rubricTools).toContain("file_read");
    expect(rubricTools).toContain("glob");
    expect(rubricTools).toContain("grep");
  });
});
