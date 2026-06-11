/**
 * Tests for `alfred ledger verify` — the locate/format plumbing
 * (src/orchestrator/ledgerLocate.ts) and the CLI subcommand end-to-end:
 *
 *  - findLatestLedger: missing root → null; picks the newest run dir;
 *    skips run dirs without a ledger.jsonl
 *  - formatVerifyOutcome: intact vs tamper rendering
 *  - CLI: exits 0 on an intact ledger, 2 after a single-byte tamper
 *    (the documented tamper exit code), 1 with guidance when no ledger exists
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/orchestrator/ledger.ts";
import { findLatestLedger, formatVerifyOutcome } from "../src/orchestrator/ledgerLocate.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    `alfred-ledger-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

const SECRET = "test-secret";

/** Create `.alfred/workflows/<runId>/ledger.jsonl` with two signed rows. */
async function makeRun(cwd: string, runId: string, withLedger = true): Promise<string> {
  const dir = join(cwd, ".alfred", "workflows", runId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "ledger.jsonl");
  if (withLedger) {
    const ledger = new Ledger(path, SECRET);
    await ledger.append("feature", { feature: "demo-1", status: "passing" });
    await ledger.append("run_end", { passing: 1, blocked: 0 });
  }
  return path;
}

// ---------------------------------------------------------------------------
// findLatestLedger
// ---------------------------------------------------------------------------

describe("findLatestLedger", () => {
  test("returns null when .alfred/workflows does not exist", async () => {
    const cwd = await makeTempDir();
    expect(await findLatestLedger(cwd)).toBeNull();
  });

  test("picks the newest run directory", async () => {
    const cwd = await makeTempDir();
    await makeRun(cwd, "2026-06-10T10-00-00-000Z");
    const newest = await makeRun(cwd, "2026-06-11T09-00-00-000Z");
    expect(await findLatestLedger(cwd)).toBe(newest);
  });

  test("skips run dirs without a ledger.jsonl", async () => {
    const cwd = await makeTempDir();
    const older = await makeRun(cwd, "2026-06-10T10-00-00-000Z");
    await makeRun(cwd, "2026-06-11T09-00-00-000Z", false);
    expect(await findLatestLedger(cwd)).toBe(older);
  });
});

// ---------------------------------------------------------------------------
// formatVerifyOutcome
// ---------------------------------------------------------------------------

describe("formatVerifyOutcome", () => {
  test("renders an intact ledger with row count and path", () => {
    const msg = formatVerifyOutcome("/x/ledger.jsonl", 3, { ok: true });
    expect(msg).toContain("✓ ledger intact — 3 rows");
    expect(msg).toContain("/x/ledger.jsonl");
  });

  test("uses singular noun for one row", () => {
    expect(formatVerifyOutcome("/x/ledger.jsonl", 1, { ok: true })).toContain("1 row,");
  });

  test("renders a tampered ledger with row index and reason", () => {
    const msg = formatVerifyOutcome("/x/ledger.jsonl", 3, {
      ok: false,
      brokenAt: 1,
      reason: "Signature mismatch at seq 1",
    });
    expect(msg).toContain("✗ TAMPER DETECTED at row 1");
    expect(msg).toContain("Signature mismatch");
  });
});

// ---------------------------------------------------------------------------
// CLI end-to-end
// ---------------------------------------------------------------------------

describe("alfred ledger verify (CLI)", () => {
  const CLI = join(import.meta.dir, "..", "src", "index.ts");

  async function runCli(
    cwd: string,
    args: readonly string[],
    env: Record<string, string> = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["bun", CLI, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, stdout, stderr };
  }

  test("exits 0 and reports intact on a valid ledger", async () => {
    const cwd = await makeTempDir();
    await makeRun(cwd, "2026-06-11T09-00-00-000Z");
    const r = await runCli(cwd, ["ledger", "verify"], { ALFRED_LEDGER_SECRET: SECRET });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("✓ ledger intact — 2 rows");
  });

  test("exits 2 and reports tamper after a single-byte edit", async () => {
    const cwd = await makeTempDir();
    const path = await makeRun(cwd, "2026-06-11T09-00-00-000Z");
    const text = await Bun.file(path).text();
    await Bun.write(path, text.replace('"passing"', '"PASSING"'));
    const r = await runCli(cwd, ["ledger", "verify"], { ALFRED_LEDGER_SECRET: SECRET });
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("✗ TAMPER DETECTED at row 0");
  });

  test("verifies an explicit path argument", async () => {
    const cwd = await makeTempDir();
    const path = await makeRun(cwd, "2026-06-11T09-00-00-000Z");
    const r = await runCli(cwd, ["ledger", "verify", path], { ALFRED_LEDGER_SECRET: SECRET });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("✓ ledger intact");
  });

  test("exits 1 with guidance when no ledger exists", async () => {
    const cwd = await makeTempDir();
    const r = await runCli(cwd, ["ledger", "verify"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("No run ledger found");
  });
});
