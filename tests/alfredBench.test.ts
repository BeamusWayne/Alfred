/**
 * Tests for Alfred-Bench — ADR 0001 §9 Phase 4 (Alfred-Bench)
 *
 * Tests the held-out invariant WITHOUT a real model:
 *  1. Held-out tests are absent from the target dir before/after a verify cycle.
 *  2. runHeldOutVerify returns the real exit code from the test command.
 *  3. alfredBench with a stub runtime (whose implement step writes a correct file)
 *     reports dualPassConfirmed=1 for a feature that goes FAIL→PASS, and
 *     dualPassConfirmed=0 when the file is never written.
 *
 * All tests use tmpdir() + cleanup; no real model or API key is required.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rm, writeFile, access, readdir } from "node:fs/promises";
import { runHeldOutVerify, alfredBench } from "../src/bench/alfredBench.ts";
import type { BenchSpec, BenchDeps } from "../src/bench/alfredBench.ts";
import { Ledger } from "../src/orchestrator/ledger.ts";
import { Journal } from "../src/orchestrator/journal.ts";
import type { Runtime, AgentCallOptions, Stage } from "../src/orchestrator/runtime.ts";
import type { AgentRun } from "../src/orchestrator/agent.ts";

// ---------------------------------------------------------------------------
// Temp dir management
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

async function makeTempDir(suffix = ""): Promise<string> {
  const dir = join(
    tmpdir(),
    `alfred-bench-test-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`,
  );
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

// ---------------------------------------------------------------------------
// Helper: check whether a path exists
// ---------------------------------------------------------------------------

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helper: list file names (non-recursive) in a dir
// ---------------------------------------------------------------------------

async function listFileNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Stub runtime factory
//
// Calls `onImplement(featureId)` during implement/editor agent steps.
// Returns rubric=2 for rubric steps (so autonomousRun marks the feature
// passing whenever the verify gate also exits 0).
// ---------------------------------------------------------------------------

function makeStubRuntime(
  onImplement: (featureId: string) => Promise<void> | void,
): Runtime {
  return {
    runId: "stub-run-id",

    async agent<T = unknown>(
      _prompt: string,
      opts?: AgentCallOptions,
    ): Promise<AgentRun<T>> {
      const label = opts?.label ?? "";

      // Implement / editor steps: execute the stub side-effect.
      if (label.startsWith("implement:") || label.startsWith("editor:")) {
        const featureId = label.split(":")[1]?.split("#")[0] ?? "unknown";
        await onImplement(featureId);
      }

      // Rubric steps: always return verification=2 so the inner loop treats the
      // feature as passing (subject to the verify gate also exiting 0).
      if (label.startsWith("rubric:")) {
        return {
          text: "",
          data: { verification: 2, reasoning: "stub: always pass" } as T,
          status: "success" as const,
          cost: undefined,
          turns: 1,
        };
      }

      // All other steps (architect/plan): return empty/undefined.
      return {
        text: "",
        data: undefined as T,
        status: "success" as const,
        cost: undefined,
        turns: 1,
      };
    },

    async parallel<T>(thunks: ReadonlyArray<() => Promise<T>>): Promise<T[]> {
      return Promise.all(thunks.map((t) => t()));
    },

    async pipeline<T>(
      items: readonly unknown[],
      ...stages: readonly Stage[]
    ): Promise<T[]> {
      return Promise.all(
        items.map(async (item, i) => {
          let acc: unknown = item;
          for (const stage of stages) acc = await stage(acc, item, i);
          return acc as T;
        }),
      );
    },

    log(_msg: string): void {
      // no-op in tests
    },

    budgetSnapshot() {
      return { usd: 0, tokens: 0, limits: {} };
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: write a minimal feature_list.json with one pending feature.
// ---------------------------------------------------------------------------

async function writeFeatureList(
  path: string,
  featureId: string,
  title: string,
): Promise<void> {
  await writeFile(
    path,
    JSON.stringify(
      {
        features: [
          {
            id: featureId,
            title,
            description: `Implement ${title}.`,
            status: "pending",
            priority: 1,
            iterationBudget: 1,
          },
        ],
      },
      null,
      2,
    ) + "\n",
  );
}

// ---------------------------------------------------------------------------
// Helper: build minimal BenchDeps (independent ledger + journal per test).
// ---------------------------------------------------------------------------

async function makeDeps(
  runtime: Runtime,
): Promise<BenchDeps> {
  const ledger = new Ledger(
    join(await makeTempDir("-ledger"), "ledger.jsonl"),
    "test-secret",
  );
  const journal = new Journal(join(await makeTempDir("-journal"), "journal.jsonl"));
  return { runtime, ledger, journal };
}

// ---------------------------------------------------------------------------
// 1. Held-out invariant — runHeldOutVerify
// ---------------------------------------------------------------------------

describe("held-out invariant — runHeldOutVerify", () => {
  test("held-out test file is absent from target before runHeldOutVerify is called", async () => {
    const targetDir = await makeTempDir("-target");
    const heldOutDir = await makeTempDir("-held-out");
    await writeFile(join(heldOutDir, "gate.test.ts"), "// held-out test");

    const spec: BenchSpec = {
      targetDir,
      heldOutTestsDir: heldOutDir,
      featureListPath: join(targetDir, "fl.json"),
      testCmd: "exit 1",
    };

    const before = await listFileNames(targetDir);
    expect(before).not.toContain("gate.test.ts");
  });

  test("held-out test file is absent from target AFTER runHeldOutVerify completes", async () => {
    const targetDir = await makeTempDir("-target");
    const heldOutDir = await makeTempDir("-held-out");
    await writeFile(join(heldOutDir, "gate.test.ts"), "// held-out test");

    const spec: BenchSpec = {
      targetDir,
      heldOutTestsDir: heldOutDir,
      featureListPath: join(targetDir, "fl.json"),
      testCmd: "exit 1",
    };

    await runHeldOutVerify(spec);

    const after = await listFileNames(targetDir);
    expect(after).not.toContain("gate.test.ts");
  });

  test("multiple held-out files are all removed after runHeldOutVerify", async () => {
    const targetDir = await makeTempDir("-target");
    const heldOutDir = await makeTempDir("-held-out");
    await writeFile(join(heldOutDir, "a.test.ts"), "// a");
    await writeFile(join(heldOutDir, "b.test.ts"), "// b");
    await writeFile(join(heldOutDir, "c.test.ts"), "// c");

    const spec: BenchSpec = {
      targetDir,
      heldOutTestsDir: heldOutDir,
      featureListPath: join(targetDir, "fl.json"),
      testCmd: "exit 0",
    };

    await runHeldOutVerify(spec);

    const after = await listFileNames(targetDir);
    expect(after).not.toContain("a.test.ts");
    expect(after).not.toContain("b.test.ts");
    expect(after).not.toContain("c.test.ts");
  });

  test("held-out files are removed even when testCmd fails (post-check step)", async () => {
    const targetDir = await makeTempDir("-target");
    const heldOutDir = await makeTempDir("-held-out");
    await writeFile(join(heldOutDir, "failing.test.ts"), "// test that fails");

    const spec: BenchSpec = {
      targetDir,
      heldOutTestsDir: heldOutDir,
      featureListPath: join(targetDir, "fl.json"),
      testCmd: "exit 1", // always fails — simulates a broken test
    };

    await runHeldOutVerify(spec);

    const after = await listFileNames(targetDir);
    expect(after).not.toContain("failing.test.ts");
  });

  test("runHeldOutVerify returns real exit code — testCmd exit 0", async () => {
    const targetDir = await makeTempDir();
    const heldOutDir = await makeTempDir();
    const spec: BenchSpec = {
      targetDir,
      heldOutTestsDir: heldOutDir,
      featureListPath: join(targetDir, "fl.json"),
      testCmd: "exit 0",
    };
    const outcome = await runHeldOutVerify(spec);
    expect(outcome.preResult.exitCode).toBe(0);
    expect(outcome.postResult?.exitCode).toBe(0);
  });

  test("runHeldOutVerify returns real exit code — testCmd exit 1", async () => {
    const targetDir = await makeTempDir();
    const heldOutDir = await makeTempDir();
    const spec: BenchSpec = {
      targetDir,
      heldOutTestsDir: heldOutDir,
      featureListPath: join(targetDir, "fl.json"),
      testCmd: "exit 1",
    };
    const outcome = await runHeldOutVerify(spec);
    expect(outcome.preResult.exitCode).toBe(1);
    expect(outcome.postResult?.exitCode).toBe(1);
  });

  test("preFail=true when testCmd fails before the held-out copy", async () => {
    const targetDir = await makeTempDir();
    const heldOutDir = await makeTempDir();
    const spec: BenchSpec = {
      targetDir,
      heldOutTestsDir: heldOutDir,
      featureListPath: join(targetDir, "fl.json"),
      testCmd: "exit 1",
    };
    const outcome = await runHeldOutVerify(spec);
    expect(outcome.preFail).toBe(true);
  });

  test("preFail=false when testCmd already passes before copy (no pre-fail)", async () => {
    const targetDir = await makeTempDir();
    const heldOutDir = await makeTempDir();
    const spec: BenchSpec = {
      targetDir,
      heldOutTestsDir: heldOutDir,
      featureListPath: join(targetDir, "fl.json"),
      testCmd: "exit 0", // already passing — no pre-fail
    };
    const outcome = await runHeldOutVerify(spec);
    expect(outcome.preFail).toBe(false);
  });

  test("dualPass=true when held-out file makes the cmd pass (FAIL→PASS)", async () => {
    // Gate: succeed only when a specific file is present in targetDir.
    const targetDir = await makeTempDir();
    const heldOutDir = await makeTempDir();
    const markerInTarget = join(targetDir, "marker.txt");

    // The held-out dir contains the marker — copying it in makes the cmd succeed.
    await writeFile(join(heldOutDir, "marker.txt"), "present");

    const testCmd = `test -f ${markerInTarget}`;
    const spec: BenchSpec = {
      targetDir,
      heldOutTestsDir: heldOutDir,
      featureListPath: join(targetDir, "fl.json"),
      testCmd,
    };

    const outcome = await runHeldOutVerify(spec);

    // Before copy: marker absent → preFail=true.
    expect(outcome.preFail).toBe(true);
    // After copy: marker present → postPass=true.
    expect(outcome.postPass).toBe(true);
    expect(outcome.dualPass).toBe(true);
    // After the verify cycle: marker removed from targetDir.
    expect(await pathExists(markerInTarget)).toBe(false);
  });

  test("dualPass=false when preFail=false (testCmd already passes before copy)", async () => {
    const targetDir = await makeTempDir();
    const heldOutDir = await makeTempDir();
    const spec: BenchSpec = {
      targetDir,
      heldOutTestsDir: heldOutDir,
      featureListPath: join(targetDir, "fl.json"),
      testCmd: "exit 0", // pre-check passes → no FAIL→PASS transition
    };
    const outcome = await runHeldOutVerify(spec);
    expect(outcome.preFail).toBe(false);
    expect(outcome.dualPass).toBe(false);
  });

  test("empty heldOutTestsDir: no files copied, target unchanged", async () => {
    const targetDir = await makeTempDir();
    const heldOutDir = await makeTempDir(); // empty

    const spec: BenchSpec = {
      targetDir,
      heldOutTestsDir: heldOutDir,
      featureListPath: join(targetDir, "fl.json"),
      testCmd: "exit 1",
    };

    const before = await listFileNames(targetDir);
    await runHeldOutVerify(spec);
    const after = await listFileNames(targetDir);
    expect(after).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// 2. alfredBench — dual-pass accounting with stub runtime
// ---------------------------------------------------------------------------

describe("alfredBench — dual-pass accounting", () => {
  test("dualPassConfirmed=1 when stub runtime writes the sentinel file (FAIL→PASS)", async () => {
    const targetDir = await makeTempDir("-target");
    const heldOutDir = await makeTempDir("-held-out");
    const sentinelInTarget = join(targetDir, "sentinel.txt");
    const featureListPath = join(targetDir, "feature_list.json");

    await writeFeatureList(featureListPath, "feat-pass", "Write sentinel file");

    // testCmd: passes only when sentinel.txt exists in targetDir.
    const testCmd = `test -f ${sentinelInTarget}`;

    const spec: BenchSpec = {
      targetDir,
      heldOutTestsDir: heldOutDir,
      featureListPath,
      testCmd,
    };

    // Stub runtime: implement step writes the sentinel file.
    const runtime = makeStubRuntime(async () => {
      await writeFile(sentinelInTarget, "done");
    });
    const deps = await makeDeps(runtime);

    const result = await alfredBench(spec, deps);

    expect(result.features).toBe(1);
    expect(result.passing).toBe(1);
    expect(result.dualPassConfirmed).toBe(1);
    expect(result.ledgerOk).toBe(true);
  });

  test("dualPassConfirmed=0 when stub runtime never writes the file", async () => {
    const targetDir = await makeTempDir("-target");
    const heldOutDir = await makeTempDir("-held-out");
    const sentinelInTarget = join(targetDir, "sentinel.txt");
    const featureListPath = join(targetDir, "feature_list.json");

    await writeFeatureList(featureListPath, "feat-fail", "Write sentinel file");

    const testCmd = `test -f ${sentinelInTarget}`;

    const spec: BenchSpec = {
      targetDir,
      heldOutTestsDir: heldOutDir,
      featureListPath,
      testCmd,
    };

    // Stub runtime: implement step is a no-op — sentinel never written.
    // autonomousRun marks the feature blocked (verify gate always exits 1).
    const runtime = makeStubRuntime(async () => {
      // intentionally empty
    });
    const deps = await makeDeps(runtime);

    const result = await alfredBench(spec, deps);

    expect(result.features).toBe(1);
    expect(result.passing).toBe(0);
    expect(result.dualPassConfirmed).toBe(0);
    // Ledger must still be intact even on a blocked run.
    expect(result.ledgerOk).toBe(true);
  });

  test("ledgerOk=true after a successful run; chain verifies independently", async () => {
    const targetDir = await makeTempDir("-target");
    const heldOutDir = await makeTempDir("-held-out");
    const sentinelInTarget = join(targetDir, "sentinel.txt");
    const featureListPath = join(targetDir, "feature_list.json");
    const ledgerFilePath = join(await makeTempDir("-ledger"), "ledger.jsonl");

    await writeFeatureList(featureListPath, "feat-ledger", "Write sentinel");

    const spec: BenchSpec = {
      targetDir,
      heldOutTestsDir: heldOutDir,
      featureListPath,
      testCmd: `test -f ${sentinelInTarget}`,
    };

    const runtime = makeStubRuntime(async () => {
      await writeFile(sentinelInTarget, "ok");
    });
    const ledger = new Ledger(ledgerFilePath, "test-secret");
    const journal = new Journal(join(await makeTempDir("-journal"), "journal.jsonl"));
    const deps: BenchDeps = { runtime, ledger, journal };

    const result = await alfredBench(spec, deps);
    expect(result.ledgerOk).toBe(true);

    // Independently re-verify the chain with a fresh Ledger reader.
    const verifyResult = await new Ledger(ledgerFilePath, "test-secret").verify();
    expect(verifyResult.ok).toBe(true);
  });

  test("features count matches the feature_list", async () => {
    const targetDir = await makeTempDir("-target");
    const heldOutDir = await makeTempDir("-held-out");
    const sentinelInTarget = join(targetDir, "sentinel.txt");
    const featureListPath = join(targetDir, "feature_list.json");

    await writeFeatureList(featureListPath, "feat-count", "Count test");

    const spec: BenchSpec = {
      targetDir,
      heldOutTestsDir: heldOutDir,
      featureListPath,
      testCmd: `test -f ${sentinelInTarget}`,
    };

    const runtime = makeStubRuntime(async () => {
      await writeFile(sentinelInTarget, "ok");
    });
    const deps = await makeDeps(runtime);

    const result = await alfredBench(spec, deps);
    expect(result.features).toBe(1);
  });
});
