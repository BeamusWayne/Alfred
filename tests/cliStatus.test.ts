/**
 * Tests for the status screen (src/cli/status.ts): fact gathering over an
 * empty dir / a feature_list / a finished run, the contextual suggestions,
 * and the plain-text rendering.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { palette } from "../src/cli/colors.ts";
import { gatherStatus, renderStatus, type StatusInfo, suggestions } from "../src/cli/status.ts";
import { Ledger } from "../src/orchestrator/ledger.ts";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    `alfred-status-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  tempDirs = [];
});

const plain = palette({ isTTY: false });
const ENV = { provider: "anthropic", model: "m-test", keyPresent: true, mockActive: false };

describe("gatherStatus", () => {
  test("empty directory → no feature_list, no last run", async () => {
    const cwd = await makeTempDir();
    const s = await gatherStatus(cwd, ENV);
    expect(s.featureList).toBeNull();
    expect(s.lastRun).toBeNull();
    expect(s.keyPresent).toBe(true);
  });

  test("reads feature_list counts and the latest run_end row", async () => {
    const cwd = await makeTempDir();
    await Bun.write(
      join(cwd, "feature_list.json"),
      JSON.stringify({
        features: [
          { id: "a", title: "A", description: "", status: "pending" },
          { id: "b", title: "B", description: "", status: "passing" },
        ],
      }),
    );
    const runDir = join(cwd, ".alfred", "workflows", "2026-06-11T00-00-00-000Z");
    const ledger = new Ledger(join(runDir, "ledger.jsonl"), "s");
    await ledger.append("run_end", { passing: 1, blocked: 0, stopped: "all_resolved" });

    const s = await gatherStatus(cwd, ENV);
    expect(s.featureList?.pending).toBe(1);
    expect(s.featureList?.passing).toBe(1);
    expect(s.lastRun?.runId).toBe("2026-06-11T00-00-00-000Z");
    expect(s.lastRun?.passing).toBe(1);
    expect(s.lastRun?.stopped).toBe("all_resolved");
  });

  test("invalid feature_list.json degrades to null instead of throwing", async () => {
    const cwd = await makeTempDir();
    await Bun.write(join(cwd, "feature_list.json"), "{not json");
    const s = await gatherStatus(cwd, ENV);
    expect(s.featureList).toBeNull();
  });
});

describe("suggestions", () => {
  const base: StatusInfo = {
    version: "0.0.0",
    provider: "anthropic",
    model: "m",
    keyPresent: false,
    mockActive: false,
    featureList: null,
    lastRun: null,
  };

  test("no key → demo first, then the export line", () => {
    const out = suggestions(base);
    expect(out[0]).toContain("alfred demo");
    expect(out[1]).toContain("ANTHROPIC_API_KEY");
  });

  test("key + pending features → suggests alfred run", () => {
    const out = suggestions({
      ...base,
      keyPresent: true,
      featureList: { path: "feature_list.json", pending: 2, inProgress: 0, passing: 0, blocked: 0 },
    });
    expect(out.some((s) => s.includes("alfred run"))).toBe(true);
  });

  test("blocked last run → suggests alfred why", () => {
    const out = suggestions({
      ...base,
      keyPresent: true,
      lastRun: { runId: "r", ledgerPath: "p", passing: 0, blocked: 1, stopped: "too_many_blocked" },
    });
    expect(out.some((s) => s.includes("alfred why"))).toBe(true);
  });
});

describe("renderStatus", () => {
  test("renders all facts and the next-step block", () => {
    const text = renderStatus(
      {
        version: "9.9.9",
        provider: "anthropic",
        model: "m-test",
        keyPresent: true,
        mockActive: false,
        featureList: {
          path: "feature_list.json",
          pending: 1,
          inProgress: 0,
          passing: 2,
          blocked: 0,
        },
        lastRun: { runId: "r1", ledgerPath: "lp", passing: 2, blocked: 0, stopped: "all_resolved" },
      },
      plain,
    );
    expect(text).toContain("alfred v9.9.9");
    expect(text).toContain("key ✓");
    expect(text).toContain("1 pending");
    expect(text).toContain("2 passing");
    expect(text).toContain("r1 — 2 passing · 0 blocked (all_resolved)");
    expect(text).toContain("next:");
  });
});
