/**
 * Alfred-Bench library — ADR 0001 §9 Phase 4 (Alfred-Bench).
 *
 * The moonshot self-rebuild harness: a model rebuilds code from a target dir
 * under a verification gate it cannot see or edit. The held-out test suite
 * lives in a separate directory and is copied into the target ONLY at check
 * time (outside the model's turns), then removed — so the agent never reads the
 * gate it must satisfy. A feature counts only when the held-out suite goes
 * FAIL → PASS across the run (dual pass-condition, SWE-bench Verified style).
 *
 * Two distinct commands keep the design sound:
 *   - `buildCmd`  the inner gate the MODEL sees each turn (an artifact/build
 *                 check it can satisfy; the held-out tests are NOT present).
 *   - `testCmd`   the HELD-OUT suite, run only by the harness at check time
 *                 with the tests copied in, then removed.
 *
 * Three properties make it impossible to game:
 *  1. Held-out verification — the model cannot access the test files between turns.
 *  2. Dual FAIL→PASS — the held-out suite must fail before and pass after.
 *  3. Signed ledger — every outcome is HMAC hash-chained (tampering is detectable).
 */

import { cp, rm, readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { runVerify, passed, type VerifyResult } from "../harness/verify.ts";
import { loadFeatureList, counts } from "../harness/featureList.ts";
import { autonomousRun } from "../orchestrator/workflows/autonomousRun.ts";
import type { Runtime } from "../orchestrator/runtime.ts";
import type { Ledger } from "../orchestrator/ledger.ts";
import type { Journal } from "../orchestrator/journal.ts";

/**
 * Mandatory verify timeout for the bench. Generous enough for a real held-out
 * suite, finite so a model that emits an infinite loop / hanging test cannot
 * stall the bench forever.
 */
const BENCH_VERIFY_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Configuration for a single Alfred-Bench run.
 *
 * `targetDir`       — the dir the model works in; must NOT contain the test files.
 * `heldOutTestsDir` — dir holding the held-out suite (never shown to the model);
 *                     MUST live outside `targetDir`.
 * `featureListPath` — path to the feature_list.json describing the target features.
 * `buildCmd`        — the inner gate the model sees each turn (e.g. an artifact
 *                     or type check). Held-out tests are absent when it runs.
 * `testCmd`         — the held-out suite, run only at check time with the tests
 *                     copied in (e.g. "bun test").
 */
export interface BenchSpec {
  readonly targetDir: string;
  readonly heldOutTestsDir: string;
  readonly featureListPath: string;
  readonly buildCmd: string;
  readonly testCmd: string;
}

/** Aggregate result returned by `alfredBench`. */
export interface BenchResult {
  readonly features: number;
  readonly passing: number;
  readonly dualPassConfirmed: number;
  readonly ledgerOk: boolean;
  readonly baselineFailed: boolean;
}

// ---------------------------------------------------------------------------
// Internal: held-out file copy helpers
// ---------------------------------------------------------------------------

async function listFiles(dir: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

async function copyHeldOutTests(heldOutDir: string, targetDir: string): Promise<readonly string[]> {
  const sources = await listFiles(heldOutDir);
  const destinations: string[] = [];
  for (const src of sources) {
    const dest = join(targetDir, basename(src));
    await cp(src, dest, { recursive: true });
    destinations.push(dest);
  }
  return destinations;
}

async function removeFiles(paths: readonly string[]): Promise<void> {
  for (const p of paths) {
    await rm(p, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// runHeldOut
// ---------------------------------------------------------------------------

/**
 * Run the held-out suite exactly once: copy the held-out tests into the target,
 * run `testCmd`, then remove them — even if the run throws. The tests are
 * present ONLY for the duration of this check, never during the model's turns,
 * so the agent cannot read or game them.
 */
export async function runHeldOut(spec: BenchSpec, timeoutMs?: number): Promise<VerifyResult> {
  const copied = await copyHeldOutTests(spec.heldOutTestsDir, spec.targetDir);
  try {
    return await runVerify(spec.testCmd, { cwd: spec.targetDir, timeoutMs });
  } finally {
    await removeFiles(copied);
  }
}

// ---------------------------------------------------------------------------
// alfredBench
// ---------------------------------------------------------------------------

export interface BenchDeps {
  readonly runtime: Runtime;
  readonly ledger: Ledger;
  readonly journal: Journal;
}

/**
 * Drive an Alfred-Bench run:
 *  1. Baseline: run the held-out suite BEFORE the model works — it must FAIL
 *     (the features are not implemented yet).
 *  2. Run `autonomousRun` using `buildCmd` as the inner verify gate. The
 *     held-out tests are NOT present during the model's turns.
 *  3. Post-check: run the held-out suite AFTER the run — dual-pass is confirmed
 *     when the baseline FAILED and the post-check now PASSES.
 *  4. Every outcome is recorded in the signed ledger.
 *
 * `runtime`/`ledger`/`journal` are injected so the function is unit-testable
 * with stubs (no real model needed).
 */
export async function alfredBench(spec: BenchSpec, deps: BenchDeps): Promise<BenchResult> {
  const { runtime, ledger } = deps;

  // Mandatory timeout for every verify run. The held-out suite and the inner
  // gate both execute model-authored code, so without a bound an infinite loop
  // / hanging test would wedge the whole bench forever.
  const verifyTimeoutMs = BENCH_VERIFY_TIMEOUT_MS;

  // Step 1 — baseline: the held-out suite must fail before any work is done.
  const pre = await runHeldOut(spec, verifyTimeoutMs);
  const baselineFailed = !passed(pre);
  await ledger.append("bench_baseline", { failed: baselineFailed, exitCode: pre.exitCode });

  // Step 2 — the model rebuilds, gated by buildCmd (held-out tests absent).
  await autonomousRun({
    runtime,
    ledger,
    cwd: spec.targetDir,
    featureListPath: spec.featureListPath,
    verifyCmd: spec.buildCmd,
    verifyTimeoutMs,
  });

  // Step 3 — post-check: run the held-out suite with the implementation present.
  const list = await loadFeatureList(spec.featureListPath);
  const c = counts(list);
  const passingFeatures = list.features.filter((f) => f.status === "passing").length;

  let dualPassConfirmed = 0;
  let postExitCode = -1;
  if (passingFeatures > 0) {
    const post = await runHeldOut(spec, verifyTimeoutMs);
    postExitCode = post.exitCode;
    const dualPass = baselineFailed && passed(post);
    // The held-out suite covers the implemented features as a whole; a green
    // suite after a failing baseline confirms the dual condition for them.
    dualPassConfirmed = dualPass ? passingFeatures : 0;
  }

  await ledger.append("bench_post_check", {
    baselineFailed,
    passing: c.passing,
    dualPassConfirmed,
    postExitCode,
  });

  const ledgerVerify = await ledger.verify();
  return {
    features: list.features.length,
    passing: c.passing,
    dualPassConfirmed,
    ledgerOk: ledgerVerify.ok,
    baselineFailed,
  };
}

/**
 * The bench pass-condition: a green, trustworthy receipt requires that at least
 * one feature was actually dual-confirmed against the held-out suite, that every
 * feature dual-confirmed, and that the ledger chain is intact. The `> 0` guard
 * is essential — an empty/emptied feature list otherwise satisfies `0 === 0` and
 * reports a passing receipt for a run that proved nothing.
 */
export function benchPassed(result: BenchResult): boolean {
  return result.features > 0 && result.dualPassConfirmed === result.features && result.ledgerOk;
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------
export type { VerifyResult } from "../harness/verify.ts";
export type { Feature } from "../harness/featureList.ts";
