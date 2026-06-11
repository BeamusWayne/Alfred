/**
 * Tests for `alfred watch` (src/cli/watch.ts) — the read-only live panel over
 * a run's journal.jsonl + ledger.jsonl.
 *
 * Pure pieces (byte-level JSONL splitter, line renderers, status line) are
 * tested exactly; the poll loop is tested against a real temp run directory
 * in both replay (run already ended) and follow (run_end appended later)
 * modes.
 */
import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { palette } from "../src/cli/colors.ts";
import {
  formatElapsed,
  renderJournalEntry,
  renderLedgerRow,
  renderStatusLine,
  resolveWatchDir,
  splitJsonl,
  type WatchIo,
  watchRun,
} from "../src/cli/watch.ts";

const plain = palette({ isTTY: false });
const enc = (s: string) => new TextEncoder().encode(s);

// ---------------------------------------------------------------------------
// splitJsonl — byte-level incremental JSONL parsing
// ---------------------------------------------------------------------------

describe("splitJsonl", () => {
  test("buffers partial trailing lines across chunks", () => {
    const first = splitJsonl(new Uint8Array(0), enc('{"a":1}\n{"b"'));
    expect(first.values).toEqual([{ a: 1 }]);
    const second = splitJsonl(first.carry, enc(":2}\n"));
    expect(second.values).toEqual([{ b: 2 }]);
    expect(second.carry.length).toBe(0);
  });

  test("skips unparseable lines instead of throwing", () => {
    const out = splitJsonl(new Uint8Array(0), enc('{oops}\n{"ok":true}\n'));
    expect(out.values).toEqual([{ ok: true }]);
  });

  test("reassembles multi-byte characters split across chunks", () => {
    const whole = enc('{"m":"中文"}\n');
    const cut = 8; // inside the first multi-byte character
    const first = splitJsonl(new Uint8Array(0), whole.slice(0, cut));
    expect(first.values).toEqual([]);
    const second = splitJsonl(first.carry, whole.slice(cut));
    expect(second.values).toEqual([{ m: "中文" }]);
  });

  test("ignores blank lines", () => {
    const out = splitJsonl(new Uint8Array(0), enc('\n{"a":1}\n\n'));
    expect(out.values).toEqual([{ a: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// Line renderers — exact, plain-palette strings
// ---------------------------------------------------------------------------

describe("renderJournalEntry", () => {
  test("agent success renders label, mark, cost and turns", () => {
    const entry = {
      type: "agent",
      label: "implement:demo-add#1",
      data: { status: "success", cost: { usd: 0.01422 }, turns: 4 },
      seq: 1,
      ts: 1,
    };
    expect(renderJournalEntry(entry, plain)).toBe("⚙ implement:demo-add#1 ✓ · $0.0142 · 4 turns");
  });

  test("agent failure renders ✗ and omits absent cost/turns", () => {
    const entry = { type: "agent", label: "rubric:f1", data: { status: "error" }, seq: 2, ts: 2 };
    expect(renderJournalEntry(entry, plain)).toBe("⚙ rubric:f1 ✗");
  });

  test("log entries render their message", () => {
    const entry = { type: "log", label: "log", data: { message: "compacted" }, seq: 3, ts: 3 };
    expect(renderJournalEntry(entry, plain)).toBe("· compacted");
  });

  test("unknown shapes render nothing", () => {
    expect(renderJournalEntry({ type: "mystery" }, plain)).toBeNull();
    expect(renderJournalEntry(null, plain)).toBeNull();
    expect(renderJournalEntry("nope", plain)).toBeNull();
  });
});

describe("renderLedgerRow", () => {
  test("feature rows render status, verify exit and rubric", () => {
    const row = {
      kind: "feature",
      data: { feature: "demo-add", status: "passing", verifyExit: 0, rubric: 2 },
      seq: 0,
      ts: 1,
    };
    expect(renderLedgerRow(row, plain)).toBe("✓ demo-add passing · verify exit 0 · rubric 2");
  });

  test("blocked features render with ✗", () => {
    const row = {
      kind: "feature",
      data: { feature: "f2", status: "blocked", verifyExit: 1, rubric: 0 },
      seq: 1,
      ts: 2,
    };
    expect(renderLedgerRow(row, plain)).toBe("✗ f2 blocked · verify exit 1 · rubric 0");
  });

  test("run_end renders the summary line", () => {
    const row = {
      kind: "run_end",
      data: { passing: 1, blocked: 0, stopped: "all_resolved" },
      seq: 2,
      ts: 3,
    };
    expect(renderLedgerRow(row, plain)).toBe("run end: 1 passing · 0 blocked · all_resolved");
  });

  test("unknown shapes render nothing", () => {
    expect(renderLedgerRow({ kind: "mystery" }, plain)).toBeNull();
    expect(renderLedgerRow(42, plain)).toBeNull();
  });
});

describe("status line", () => {
  test("formatElapsed renders m:ss and h:mm:ss", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(134_000)).toBe("2:14");
    expect(formatElapsed(3_725_000)).toBe("1:02:05");
  });

  test("renders elapsed, progress, cost and run id", () => {
    const line = renderStatusLine(
      {
        runId: "2026-06-11T04-12-35-163Z",
        resolved: 1,
        total: 3,
        costUsd: 0.0212,
        elapsedMs: 134_000,
      },
      plain,
    );
    expect(line).toBe("⏱ 2:14 · features 1/3 · $0.0212 · 2026-06-11T04-12-35-163Z");
  });

  test("omits the total when no feature list is readable", () => {
    const line = renderStatusLine(
      { runId: "r", resolved: 2, total: null, costUsd: 0, elapsedMs: 0 },
      plain,
    );
    expect(line).toBe("⏱ 0:00 · features 2 · $0.0000 · r");
  });
});

// ---------------------------------------------------------------------------
// watchRun — poll loop over a real temp run directory
// ---------------------------------------------------------------------------

const AGENT_LINE = `${JSON.stringify({
  type: "agent",
  label: "implement:demo-add#1",
  data: { status: "success", cost: { usd: 0.01422 }, turns: 4 },
  seq: 1,
  ts: 1_000,
})}\n`;
const RUBRIC_LINE = `${JSON.stringify({
  type: "agent",
  label: "rubric:demo-add",
  data: { status: "success", cost: { usd: 0.00697 }, turns: 5 },
  seq: 2,
  ts: 2_000,
})}\n`;
const FEATURE_ROW = `${JSON.stringify({
  kind: "feature",
  data: { feature: "demo-add", status: "passing", verifyExit: 0, rubric: 2 },
  seq: 0,
  ts: 3_000,
})}\n`;
const RUN_END_ROW = `${JSON.stringify({
  kind: "run_end",
  data: { passing: 1, blocked: 0, stopped: "all_resolved" },
  seq: 1,
  ts: 4_000,
})}\n`;

interface FakeIo extends WatchIo {
  readonly lines: string[];
  readonly statuses: string[];
}

function fakeIo(): FakeIo {
  const lines: string[] = [];
  const statuses: string[] = [];
  return {
    lines,
    statuses,
    out: (line: string) => lines.push(line),
    status: (line: string) => statuses.push(line),
    clearStatus: () => undefined,
    now: () => 10_000,
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

async function tempRunDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "alfred-watch-"));
  const runDir = join(root, "2026-06-11T00-00-00-000Z");
  await mkdir(runDir);
  return runDir;
}

describe("watchRun", () => {
  test("replay: a finished run renders fully and exits 0", async () => {
    const runDir = await tempRunDir();
    await writeFile(join(runDir, "journal.jsonl"), AGENT_LINE + RUBRIC_LINE);
    await writeFile(join(runDir, "ledger.jsonl"), FEATURE_ROW + RUN_END_ROW);
    const io = fakeIo();

    const code = await watchRun(runDir, io, { palette: plain, pollMs: 1 });

    expect(code).toBe(0);
    expect(io.lines).toEqual([
      "⚙ implement:demo-add#1 ✓ · $0.0142 · 4 turns",
      "⚙ rubric:demo-add ✓ · $0.0070 · 5 turns",
      "✓ demo-add passing · verify exit 0 · rubric 2",
      "run end: 1 passing · 0 blocked · all_resolved",
    ]);
    // Aggregates reach the status line: 2 agent costs summed, 1 feature resolved.
    const last = io.statuses.at(-1);
    expect(last).toContain("features 1");
    expect(last).toContain("$0.0212");
  });

  test("replay: reads the feature list total when given", async () => {
    const runDir = await tempRunDir();
    await writeFile(join(runDir, "journal.jsonl"), AGENT_LINE);
    await writeFile(join(runDir, "ledger.jsonl"), FEATURE_ROW + RUN_END_ROW);
    const featureListPath = join(runDir, "feature_list.json");
    await writeFile(
      featureListPath,
      JSON.stringify({
        features: [
          { id: "demo-add", title: "t", description: "d", status: "passing" },
          { id: "f2", title: "t", description: "d", status: "pending" },
          { id: "f3", title: "t", description: "d", status: "pending" },
        ],
      }),
    );
    const io = fakeIo();

    const code = await watchRun(runDir, io, { palette: plain, pollMs: 1, featureListPath });

    expect(code).toBe(0);
    expect(io.statuses.at(-1)).toContain("features 1/3");
  });

  test("follow: picks up rows appended after start and exits on run_end", async () => {
    const runDir = await tempRunDir();
    await writeFile(join(runDir, "journal.jsonl"), AGENT_LINE);
    await writeFile(join(runDir, "ledger.jsonl"), "");
    const io = fakeIo();

    const running = watchRun(runDir, io, { palette: plain, pollMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await appendFile(join(runDir, "journal.jsonl"), RUBRIC_LINE);
    await appendFile(join(runDir, "ledger.jsonl"), FEATURE_ROW + RUN_END_ROW);

    const code = await running;
    expect(code).toBe(0);
    expect(io.lines).toEqual([
      "⚙ implement:demo-add#1 ✓ · $0.0142 · 4 turns",
      "⚙ rubric:demo-add ✓ · $0.0070 · 5 turns",
      "✓ demo-add passing · verify exit 0 · rubric 2",
      "run end: 1 passing · 0 blocked · all_resolved",
    ]);
  });

  test("resolveWatchDir picks the newest run dir even before its ledger exists", async () => {
    // A live attach happens before the run's first append: journal.jsonl and
    // ledger.jsonl are created lazily, so resolution must not require them.
    const cwd = await mkdtemp(join(tmpdir(), "alfred-watch-resolve-"));
    const older = join(cwd, ".alfred", "workflows", "2026-06-11T01-00-00-000Z");
    const newer = join(cwd, ".alfred", "workflows", "2026-06-11T02-00-00-000Z");
    await mkdir(older, { recursive: true });
    await mkdir(newer, { recursive: true });
    await writeFile(join(older, "ledger.jsonl"), RUN_END_ROW);

    expect(await resolveWatchDir(cwd)).toBe(newer);
    // Explicit arguments: a .jsonl resolves to its directory, a dir to itself.
    expect(await resolveWatchDir(cwd, join(older, "ledger.jsonl"))).toBe(older);
    expect(await resolveWatchDir(cwd, older)).toBe(older);
    // Stray plain files under workflows/ are not runs.
    const empty = await mkdtemp(join(tmpdir(), "alfred-watch-empty-"));
    expect(await resolveWatchDir(empty)).toBeNull();
  });

  test("a missing run directory reports an error and exits 1", async () => {
    const io = fakeIo();
    const code = await watchRun("/nonexistent/alfred-watch-test", io, {
      palette: plain,
      pollMs: 1,
    });
    expect(code).toBe(1);
    expect(io.lines.length).toBe(1);
    expect(io.lines[0]).toContain("No run found");
  });
});
