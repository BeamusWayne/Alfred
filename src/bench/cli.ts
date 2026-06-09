#!/usr/bin/env bun
/**
 * Alfred-Bench CLI — ADR 0001 §9 Phase 4 (Alfred-Bench)
 *
 * Thin runnable entry point for the Alfred-Bench harness.
 * Parses a BenchSpec JSON file, wires up runtime + ledger + journal
 * (mirroring src/index.ts runAutonomous), calls alfredBench, prints the
 * result as NDJSON to stdout, writes a human summary to stderr, and
 * exits non-zero unless all features dual-passed.
 *
 * Usage:
 *   bun run src/bench/cli.ts <spec.json>
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY      — Anthropic API key
 *   ALFRED_LEDGER_SECRET   — HMAC secret for the signed ledger (generate with
 *                            `openssl rand -hex 32` and keep it safe)
 */

import { join, resolve } from "node:path";
import { alfredBench, benchPassed, type BenchSpec } from "./alfredBench.ts";
import { createRuntime } from "../orchestrator/runtime.ts";
import { Journal } from "../orchestrator/journal.ts";
import { Ledger } from "../orchestrator/ledger.ts";
import { getProvider } from "../providers/index.ts";
import { loadConfig } from "../config/manager.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(message: string): never {
  process.stderr.write(`[alfred-bench] error: ${message}\n`);
  process.exit(1);
}

function dim(s: string): string {
  return process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write(
    "Usage: bun run src/bench/cli.ts <spec.json>\n" +
      "       <spec.json> must be a JSON file matching BenchSpec:\n" +
      "         { targetDir, heldOutTestsDir, featureListPath, buildCmd, testCmd }\n",
  );
  process.exit(1);
}

const specPath = resolve(args[0] ?? "");

// ---------------------------------------------------------------------------
// Load and validate spec
// ---------------------------------------------------------------------------

let spec: BenchSpec;
try {
  const file = Bun.file(specPath);
  const raw: unknown = await file.json();
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof (raw as Record<string, unknown>)["targetDir"] !== "string" ||
    typeof (raw as Record<string, unknown>)["heldOutTestsDir"] !== "string" ||
    typeof (raw as Record<string, unknown>)["featureListPath"] !== "string" ||
    typeof (raw as Record<string, unknown>)["buildCmd"] !== "string" ||
    typeof (raw as Record<string, unknown>)["testCmd"] !== "string"
  ) {
    die(
      `spec file must be a JSON object with string fields: targetDir, heldOutTestsDir, featureListPath, buildCmd, testCmd`,
    );
  }
  spec = raw as BenchSpec;
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  die(`failed to load spec from "${specPath}": ${msg}`);
}

// ---------------------------------------------------------------------------
// Environment checks
// ---------------------------------------------------------------------------

if (!process.env["ANTHROPIC_API_KEY"]) {
  process.stderr.write(
    dim("[alfred-bench] warning: ANTHROPIC_API_KEY is not set — model calls will fail\n"),
  );
}

if (!process.env["ALFRED_LEDGER_SECRET"]) {
  process.stderr.write(
    dim(
      "[alfred-bench] warning: ALFRED_LEDGER_SECRET is not set — using insecure default\n",
    ),
  );
}

// ---------------------------------------------------------------------------
// Build runtime, ledger, journal
// ---------------------------------------------------------------------------

const cfg = loadConfig({});
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(spec.targetDir, ".alfred", "workflows", runId);
const journal = new Journal(join(runDir, "journal.jsonl"));
const ledgerSecret =
  process.env["ALFRED_LEDGER_SECRET"] ?? "alfred-bench-dev-insecure-secret-change-me";
const ledger = new Ledger(join(runDir, "ledger.jsonl"), ledgerSecret);

const controller = new AbortController();
process.on("SIGINT", () => controller.abort());

const runtime = createRuntime(runId, {
  provider: getProvider(cfg.provider),
  model: cfg.model,
  permissions: {
    mode: "bypass",
    allowedTools: new Set(),
    deniedTools: new Set(),
    workingDir: spec.targetDir,
  },
  journal,
  signal: controller.signal,
  onLog: (m) => process.stderr.write(dim(`  ${m}\n`)),
});

process.stderr.write(
  dim(`[alfred-bench] runId=${runId} spec="${specPath}" testCmd="${spec.testCmd}"\n`),
);

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

let result: Awaited<ReturnType<typeof alfredBench>>;
try {
  result = await alfredBench(spec, { runtime, ledger, journal });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  die(`alfredBench failed: ${msg}`);
}

await journal.close();

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

// Structured result to stdout (NDJSON-style).
process.stdout.write(JSON.stringify({ type: "bench_result", ...result }) + "\n");

// Human summary to stderr.
// benchPassed requires ≥1 feature actually dual-confirmed against the held-out
// suite (the `> 0` guard) plus an intact ledger — an empty/emptied feature list
// no longer satisfies 0===0 and reports a false passing receipt.
const allDualPassed = benchPassed(result);
process.stderr.write(
  dim(
    `\n[alfred-bench] features=${result.features} passing=${result.passing} ` +
      `dualPassConfirmed=${result.dualPassConfirmed} ledger=${result.ledgerOk ? "ok" : "TAMPERED"}\n`,
  ),
);

if (!result.ledgerOk) {
  process.stderr.write(`[alfred-bench] WARN: ledger chain TAMPERED — receipt is not trustworthy\n`);
}

// Exit non-zero unless the run genuinely passed (benchPassed already requires
// ≥1 dual-confirmed feature AND an intact ledger).
process.exit(allDualPassed ? 0 : 1);
