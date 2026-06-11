/**
 * Tests for `alfred ledger show` formatting (src/cli/ledgerShow.ts): row
 * summaries per kind, the aligned terminal table, and the Markdown table.
 */
import { describe, expect, test } from "bun:test";
import { formatLedgerTable, summarizeEntry } from "../src/cli/ledgerShow.ts";
import type { LedgerEntry } from "../src/orchestrator/ledger.ts";

const FEATURE: LedgerEntry = {
  seq: 0,
  kind: "feature",
  ts: 1781147926227,
  data: { feature: "demo-add", status: "passing", verifyExit: 0, rubric: 2 },
  prevSig: "0".repeat(64),
  sig: "be1c13c57518611b5a82ec9e32da09ab240d842b1d9c8319f3f5573dd450fbb3",
};

const RUN_END: LedgerEntry = {
  seq: 1,
  kind: "run_end",
  ts: 1781147926228,
  data: { passing: 1, blocked: 0, stopped: "all_resolved" },
  prevSig: FEATURE.sig,
  sig: "74689f9abd6d49beffc2d3299c0cc2c4a93234663fa29fc7d6ee725139059fba",
};

describe("summarizeEntry", () => {
  test("feature rows include verdicts and reason when present", () => {
    expect(summarizeEntry(FEATURE)).toBe("demo-add passing · verify 0 · rubric 2");
    expect(
      summarizeEntry({
        ...FEATURE,
        data: { ...(FEATURE.data as object), status: "blocked", reason: "verify exit 1" },
      }),
    ).toContain("verify exit 1");
  });

  test("run_end rows summarize totals", () => {
    expect(summarizeEntry(RUN_END)).toBe("1 passing · 0 blocked · all_resolved");
  });
});

describe("formatLedgerTable", () => {
  test("terminal table has a header and truncated signatures", () => {
    const out = formatLedgerTable([FEATURE, RUN_END], {});
    const lines = out.split("\n");
    expect(lines[0]).toContain("seq");
    expect(lines[0]).toContain("summary");
    expect(out).toContain("be1c13c5…");
    expect(out).not.toContain(FEATURE.sig); // full sig never dumped
  });

  test("--md emits a paste-ready Markdown table", () => {
    const out = formatLedgerTable([FEATURE, RUN_END], { md: true });
    expect(out.startsWith("| seq | kind | summary | time | sig |")).toBe(true);
    expect(out).toContain("| 0 | feature | demo-add passing · verify 0 · rubric 2 |");
    expect(out).toContain("`74689f9a…`");
  });
});
