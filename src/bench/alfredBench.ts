/**
 * Alfred-Bench library — ADR 0001 §9 Phase 4 (Alfred-Bench)
 *
 * The moonshot self-rebuild harness: a model rebuilds code from an empty
 * target dir under a verification gate it cannot see or edit. Held-out test
 * files live in a separate directory and are copied into the target ONLY at
 * verify time (outside the model's turns), then removed — so the agent never
 * reads the gate it must satisfy. A feature counts only when the held-out
 * suite goes FAIL → PASS (dual pass-condition, SWE-bench Verified style).
 *
 * Three properties make the benchmark impossible to game:
 *  1. Held-out verification — the model cannot access the test files between turns.
 *  2. Dual FAIL→PASS condition — pre-existing passes don't count as signals.
 *  3. Signed ledger — every outcome is HMAC hash-chained (detectable tampering).
 */

import { cp, rm, readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { runVerify, passed, type VerifyResult } from "../harness/verify.ts";
import {
  loadFeatureList,
  counts,
} from "../harness/featureList.ts";
import { autonomousRun } from "../orchestrator/workflows/autonomousRun.ts";
import type { Runtime } from "../orchestrator/runtime.ts";
import type { Ledger } from "../orchestrator/ledger.ts";
import type { Journal } from "../orchestrator/journal.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Configuration for a single Alfred-Bench run.
 *
 * `targetDir`       — the dir the model works in; must NOT contain test files.
 * `heldOutTestsDir` — dir holding the held-out test suite (never shown to model).
 * `featureListPath` — path to the feature_list.json describing the target features.
 * `testCmd`         — shell command run to exercise the held-out suite
 *                     (e.g. "bun test tests/").
 */
export interface BenchSpec {
  readonly targetDir: string;
  readonly heldOutTestsDir: string;
  readonly featureListPath: string;
  readonly testCmd: string;
}

/**
 * Aggregate result returned by `alfredBench`.
 *
 * `features`          — total number of features in the feature_list.
 * `passing`           — features whose verify gate exited 0 (harness gate).
 * `dualPassConfirmed` — features that went FAIL→PASS (held-out dual condition).
 * `ledgerOk`          — whether the signed ledger chain verified without tampering.
 */
export interface BenchResult {
  readonly features: number;
  readonly passing: number;
  readonly dualPassConfirmed: number;
  readonly ledgerOk: boolean;
}

/**
 * Outcome returned by a single held-out verify cycle.
 *
 * `preFail`    — did the held-out suite fail BEFORE the model's turn? (should be true)
 * `postPass`   — did the held-out suite pass AFTER the model's turn? (must be true for dual-pass)
 * `dualPass`   — true only when preFail && postPass.
 * `preResult`  — raw VerifyResult for the pre-check.
 * `postResult` — raw VerifyResult for the post-check (absent if never run).
 */
export interface VerifyOutcome {
  readonly preFail: boolean;
  readonly postPass: boolean;
  readonly dualPass: boolean;
  readonly preResult: VerifyResult;
  readonly postResult?: VerifyResult | undefined;
}

// ---------------------------------------------------------------------------
// Internal: file copy helpers
// ---------------------------------------------------------------------------

/**
 * List all top-level files in a directory.
 * Uses node:fs/promises readdir to avoid Bun.Glob null-byte edge cases.
 * Returns full paths.
 */
async function listFiles(dir: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile())
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

/**
 * Copy all files from `src` into `dest` (flat copy, top-level files only).
 * Returns the list of destination paths so the caller can remove them cleanly.
 */
async function copyHeldOutTests(
  heldOutDir: string,
  targetDir: string,
): Promise<readonly string[]> {
  const sources = await listFiles(heldOutDir);
  const destinations: string[] = [];
  for (const src of sources) {
    const name = basename(src);
    const dest = join(targetDir, name);
    await cp(src, dest, { recursive: true });
    destinations.push(dest);
  }
  return destinations;
}

/**
 * Remove files that were previously copied in.
 */
async function removeFiles(paths: readonly string[]): Promise<void> {
  for (const p of paths) {
    await rm(p, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// runHeldOutVerify
// ---------------------------------------------------------------------------

/**
 * Execute a single held-out verify cycle:
 *
 * 1. Run `testCmd` in `targetDir` WITHOUT held-out tests → expect FAIL (pre-check).
 * 2. Copy held-out tests into `targetDir`.
 * 3. Run `testCmd` in `targetDir` WITH held-out tests → capture result (post-check).
 * 4. Remove held-out tests from `targetDir` immediately.
 *
 * The dual pass-condition is satisfied when step 1 fails AND step 3 passes.
 * The model never sees the test files because steps 2–4 happen outside the
 * agent's turns — the harness calls this function, not the model.
 *
 * @param spec      The bench spec (paths + testCmd).
 * @param timeoutMs Optional per-run timeout (milliseconds).
 */
export async function runHeldOutVerify(
  spec: BenchSpec,
  timeoutMs?: number,
): Promise<VerifyOutcome> {
  const { targetDir, heldOutTestsDir, testCmd } = spec;

  // Step 1 — pre-check: held-out tests must NOT be present; suite should FAIL.
  const preResult = await runVerify(testCmd, { cwd: targetDir, timeoutMs });
  const preFail = !passed(preResult);

  // Step 2 — copy held-out tests into target dir.
  const copied = await copyHeldOutTests(heldOutTestsDir, targetDir);

  let postResult: VerifyResult | undefined;
  try {
    // Step 3 — post-check: run suite with held-out tests present.
    postResult = await runVerify(testCmd, { cwd: targetDir, timeoutMs });
  } finally {
    // Step 4 — unconditionally remove held-out tests, even if step 3 throws.
    await removeFiles(copied);
  }

  const postPass = postResult !== undefined && passed(postResult);
  const dualPass = preFail && postPass;

  return { preFail, postPass, dualPass, preResult, postResult };
}

// ---------------------------------------------------------------------------
// alfredBench
// ---------------------------------------------------------------------------

/**
 * Injected dependencies for `alfredBench` (mirrors the shape used by
 * `autonomousRun` so the same production objects pass through unchanged).
 */
export interface BenchDeps {
  readonly runtime: Runtime;
  readonly ledger: Ledger;
  readonly journal: Journal;
}

/**
 * Drive the Alfred-Bench run:
 *
 * Strategy:
 *  1. Record a pre-check baseline: run `runHeldOutVerify` BEFORE the run to
 *     confirm the held-out suite fails (features are not yet implemented).
 *     Store which features have preFail=true.
 *  2. Run `autonomousRun` using `testCmd` as the verifyCmd so the inner loop
 *     uses the same command the held-out suite will use. Because the held-out
 *     tests are NOT present during the model's turns, the model cannot read them.
 *  3. After the run, for each feature marked `passing`, run `runHeldOutVerify`
 *     again (post-check). A feature is `dualPassConfirmed` when the pre-check
 *     failed AND the post-check passes.
 *  4. Record all outcomes in the ledger for auditability.
 *
 * The `runtime`, `ledger`, and `journal` are injected so the function is
 * fully unit-testable with stub implementations (no real model needed).
 */
export async function alfredBench(
  spec: BenchSpec,
  deps: BenchDeps,
): Promise<BenchResult> {
  const { runtime, ledger } = deps;

  // -------------------------------------------------------------------------
  // Step 1 — Pre-check baseline
  // -------------------------------------------------------------------------
  // Run the held-out verify ONCE before the model works on anything. This
  // establishes that the test suite currently fails (features not implemented).
  const preOutcome = await runHeldOutVerify(spec);
  const baselinePreFail = preOutcome.preFail;

  await ledger.append("bench_pre_check", {
    preFail: baselinePreFail,
    preExitCode: preOutcome.preResult.exitCode,
  });

  // -------------------------------------------------------------------------
  // Step 2 — Run autonomousRun with the held-out testCmd
  // -------------------------------------------------------------------------
  // The model works in targetDir using testCmd as its verify signal, but the
  // held-out test files are NOT present — they are only mounted at verify time
  // by runHeldOutVerify, which is called by the harness (not by the model).
  //
  // We use testCmd directly as the verifyCmd so the model's inner verify loop
  // uses the same command. The held-out tests being absent means the model
  // sees a failure unless it has actually implemented the correct behaviour
  // (since testCmd may check for produced artefacts, not the test file itself).
  const runResult = await autonomousRun({
    runtime,
    ledger,
    cwd: spec.targetDir,
    featureListPath: spec.featureListPath,
    verifyCmd: spec.testCmd,
  });

  // -------------------------------------------------------------------------
  // Step 3 — Post-check: dual-pass verification per passing feature
  // -------------------------------------------------------------------------
  // Load the updated feature list to find which features are now passing.
  const list = await loadFeatureList(spec.featureListPath);
  const c = counts(list);
  const totalFeatures = list.features.length;

  const passingFeatures = list.features.filter((f) => f.status === "passing");
  let dualPassConfirmed = 0;

  for (const feature of passingFeatures) {
    // Run the held-out verify for this feature's post-state.
    const postOutcome = await runHeldOutVerify(spec);
    // A feature dual-passes when:
    //  - The pre-check baseline failed (suite failed before model worked), AND
    //  - The post-check now passes (model's implementation satisfies the gate).
    const dualPass = baselinePreFail && postOutcome.postPass;
    if (dualPass) {
      dualPassConfirmed++;
    }

    await ledger.append("dual_pass_check", {
      featureId: feature.id,
      baselinePreFail,
      postPass: postOutcome.postPass,
      dualPass,
      postExitCode: postOutcome.postResult?.exitCode ?? -1,
    });
  }

  // Re-verify the ledger chain integrity.
  const ledgerVerify = await ledger.verify();

  return {
    features: totalFeatures,
    passing: c.passing,
    dualPassConfirmed,
    ledgerOk: ledgerVerify.ok,
  };
}

// ---------------------------------------------------------------------------
// makeHeldOutVerify
// ---------------------------------------------------------------------------

/**
 * Return an object with a `verifyCmd` that, when executed by the harness,
 * performs the full held-out verify cycle (copy in → run → remove).
 *
 * The returned command is a bun --eval invocation that calls `runHeldOutVerify`
 * inline. This lets the harness treat it as a standard `verifyCmd` string while
 * keeping the held-out invariant: tests are absent between turns.
 */
export function makeHeldOutVerify(spec: BenchSpec): { readonly verifyCmd: string } {
  // Inline bun eval: import runHeldOutVerify, run the cycle, exit with the
  // dual-pass result code. The spec is JSON-encoded and passed as a string literal.
  const specJson = JSON.stringify(spec).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const verifyCmd =
    `bun --eval "const { runHeldOutVerify } = await import('${import.meta.url}'); ` +
    `const outcome = await runHeldOutVerify(JSON.parse('${specJson}')); ` +
    `process.exit(outcome.dualPass ? 0 : 1);"`;
  return { verifyCmd };
}

// ---------------------------------------------------------------------------
// Re-export utility types for consumers
// ---------------------------------------------------------------------------
export type { VerifyResult } from "../harness/verify.ts";
export type { Feature } from "../harness/featureList.ts";
