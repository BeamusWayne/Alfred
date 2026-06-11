/**
 * Tests for `alfred why` (src/cli/why.ts): journal rubric extraction, run
 * explanation gathering from a real ledger+journal fixture, and rendering
 * (blocked first, with evidence).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { palette } from "../src/cli/colors.ts";
import { gatherWhy, renderWhy, rubricReasonsFromJournal } from "../src/cli/why.ts";
import { Ledger } from "../src/orchestrator/ledger.ts";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    `alfred-why-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

async function makeRun(cwd: string, runId: string): Promise<void> {
  const runDir = join(cwd, ".alfred", "workflows", runId);
  const ledger = new Ledger(join(runDir, "ledger.jsonl"), "s");
  await ledger.append("feature", {
    feature: "good",
    status: "passing",
    verifyExit: 0,
    rubric: 2,
    gitSha: "abc",
  });
  await ledger.append("feature", {
    feature: "bad",
    status: "blocked",
    verifyExit: 1,
    rubric: 1,
    gitSha: "abc",
    reason: "verify exit 1",
  });
  await ledger.append("run_end", { passing: 1, blocked: 1, stopped: "too_many_blocked" });
  const journalLines = [
    JSON.stringify({
      type: "agent",
      label: "rubric:bad",
      data: { data: { verification: 1, reasoning: "partial: add.ts exists but exports nothing" } },
      seq: 1,
      ts: 1,
    }),
  ];
  await Bun.write(join(runDir, "journal.jsonl"), `${journalLines.join("\n")}\n`);
}

describe("rubricReasonsFromJournal", () => {
  test("maps rubric labels to reasoning, skipping junk lines", () => {
    const text = [
      '{"type":"agent","label":"implement:x#1","data":{"data":null},"seq":0,"ts":1}',
      '{"type":"agent","label":"rubric:x","data":{"data":{"reasoning":"looks real"}},"seq":1,"ts":2}',
      "not json at all",
    ].join("\n");
    const map = rubricReasonsFromJournal(text);
    expect(map.get("x")).toBe("looks real");
    expect(map.size).toBe(1);
  });
});

describe("gatherWhy + renderWhy", () => {
  test("null when no run exists", async () => {
    const cwd = await makeTempDir();
    expect(await gatherWhy(cwd)).toBeNull();
  });

  test("collects feature verdicts, rubric reasoning and run_end", async () => {
    const cwd = await makeTempDir();
    await makeRun(cwd, "2026-06-11T01-00-00-000Z");
    const data = await gatherWhy(cwd);
    expect(data).not.toBeNull();
    if (data === null) return;
    expect(data.runId).toBe("2026-06-11T01-00-00-000Z");
    expect(data.runEnd?.stopped).toBe("too_many_blocked");
    const bad = data.features.find((f) => f.id === "bad");
    expect(bad?.status).toBe("blocked");
    expect(bad?.verifyExit).toBe(1);
    expect(bad?.rubricReasoning).toContain("exports nothing");

    const text = renderWhy(data, plain);
    expect(text).toContain("✗ bad blocked — verify exit 1");
    expect(text).toContain("rubric says: partial: add.ts exists but exports nothing");
    expect(text).toContain("✓ good passing");
    // Blocked evidence renders before the passing roll-up.
    expect(text.indexOf("✗ bad")).toBeLessThan(text.indexOf("✓ good"));
  });

  test("explicit runId targets that run", async () => {
    const cwd = await makeTempDir();
    await makeRun(cwd, "2026-06-11T01-00-00-000Z");
    await makeRun(cwd, "2026-06-11T02-00-00-000Z");
    const data = await gatherWhy(cwd, "2026-06-11T01-00-00-000Z");
    expect(data?.runId).toBe("2026-06-11T01-00-00-000Z");
  });
});
