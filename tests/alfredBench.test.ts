/**
 * Tests for the Alfred-Bench harness (ADR 0001 §9 Phase 4): the held-out
 * invariant (tests present only at check time, never during the model's turns)
 * and the dual FAIL→PASS pass-condition with a signed ledger. No real model.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, mkdir, rm, readdir, writeFile } from "node:fs/promises";
import { runHeldOut, alfredBench, type BenchSpec } from "../src/bench/alfredBench.ts";
import { MockProvider, textResponse, toolUseResponse, type Script } from "../src/providers/mock.ts";
import { createRuntime } from "../src/orchestrator/runtime.ts";
import { Journal } from "../src/orchestrator/journal.ts";
import { Ledger } from "../src/orchestrator/ledger.ts";

const tmps: string[] = [];
afterEach(async () => {
  for (const d of tmps) await rm(d, { recursive: true, force: true });
  tmps.length = 0;
});

async function fixture(): Promise<BenchSpec> {
  const root = await mkdtemp(join(tmpdir(), "alfred-bench-"));
  tmps.push(root);
  const targetDir = join(root, "target");
  const heldOutTestsDir = join(root, "heldout"); // OUTSIDE targetDir
  await mkdir(targetDir, { recursive: true });
  await mkdir(heldOutTestsDir, { recursive: true });
  await writeFile(
    join(heldOutTestsDir, "add.test.ts"),
    `import { test, expect } from "bun:test";\nimport { add } from "./src/add.ts";\ntest("adds", () => { expect(add(2, 3)).toBe(5); });\n`,
  );
  await writeFile(
    join(targetDir, "feature_list.json"),
    JSON.stringify({ features: [{ id: "add", title: "add", description: "Create src/add.ts exporting add(a,b).", status: "pending", iterationBudget: 1 }] }),
  );
  return {
    targetDir,
    heldOutTestsDir,
    featureListPath: join(targetDir, "feature_list.json"),
    buildCmd: `bun -e "const m = await import('./src/add.ts'); if (typeof m.add !== 'function') process.exit(1);"`,
    testCmd: "bun test",
  };
}

describe("runHeldOut — held-out invariant", () => {
  test("tests are absent before/after the check, present only during it", async () => {
    const spec = await fixture();
    expect((await readdir(spec.targetDir)).includes("add.test.ts")).toBe(false);
    const r = await runHeldOut(spec); // no implementation yet → suite fails
    expect(r.exitCode).not.toBe(0);
    expect((await readdir(spec.targetDir)).includes("add.test.ts")).toBe(false); // cleaned up
  });
});

function benchDeps(targetDir: string, root: string, script: Script) {
  const journal = new Journal(join(root, "j.jsonl"));
  const ledger = new Ledger(join(root, "l.jsonl"), "bench-secret");
  const runtime = createRuntime("t", {
    provider: new MockProvider([script]),
    model: "mock",
    permissions: { mode: "bypass", allowedTools: new Set(), deniedTools: new Set(), workingDir: targetDir },
    journal,
  });
  return { runtime, ledger, journal };
}

describe("alfredBench — dual FAIL→PASS", () => {
  test("confirms dual-pass when the model builds the artifact correctly", async () => {
    const spec = await fixture();
    const root = join(spec.targetDir, "..");
    const buildScript: Script = (messages) => {
      const firstUser = messages.find((m) => m.role === "user");
      const t = firstUser && typeof firstUser.content === "string" ? firstUser.content : "";
      const last = messages[messages.length - 1];
      if (t.includes("Assess whether")) {
        return last && last.role === "tool_result" ? textResponse("done") : toolUseResponse("structured_output", { verification: 2, reasoning: "built" });
      }
      return last && last.role === "tool_result"
        ? textResponse("built")
        : toolUseResponse("file_write", { path: "src/add.ts", content: "export function add(a: number, b: number): number { return a + b; }\n" });
    };
    const deps = benchDeps(spec.targetDir, root, buildScript);
    const result = await alfredBench(spec, deps);
    await deps.journal.close();
    expect(result.baselineFailed).toBe(true);
    expect(result.passing).toBe(1);
    expect(result.dualPassConfirmed).toBe(1);
    expect(result.ledgerOk).toBe(true);
    expect((await readdir(spec.targetDir)).includes("add.test.ts")).toBe(false);
  });

  test("no dual-pass when the model writes nothing (build gate fails)", async () => {
    const spec = await fixture();
    const root = join(spec.targetDir, "..");
    const noopScript: Script = (messages) => {
      const firstUser = messages.find((m) => m.role === "user");
      const t = firstUser && typeof firstUser.content === "string" ? firstUser.content : "";
      if (t.includes("Assess whether")) return toolUseResponse("structured_output", { verification: 0, reasoning: "nothing" });
      return textResponse("I did nothing");
    };
    const deps = benchDeps(spec.targetDir, root, noopScript);
    const result = await alfredBench(spec, deps);
    await deps.journal.close();
    expect(result.baselineFailed).toBe(true);
    expect(result.passing).toBe(0);
    expect(result.dualPassConfirmed).toBe(0);
    expect(result.ledgerOk).toBe(true);
  });
});
