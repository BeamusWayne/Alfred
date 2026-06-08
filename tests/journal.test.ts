/**
 * Tests for src/orchestrator/journal.ts
 *
 * ADR 0001 §5: verify append-only JSONL semantics, monotonic seq assignment,
 * round-trip readAll, resume via findByKey, missing-file and malformed-line
 * defensive behaviour, and concurrent-append safety.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { Journal } from "../src/orchestrator/journal.ts";

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(async () => {
  // Each test gets its own isolated temp directory.
  const base = join(tmpdir(), `alfred-journal-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(base, { recursive: true });
  testDir = base;
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function journalPath(name: string = "journal.jsonl"): string {
  return join(testDir, name);
}

// A fixed clock so ts values are deterministic in tests.
function fixedClock(ts: number): () => number {
  return (): number => ts;
}

// ---------------------------------------------------------------------------
// Suite: append assigns monotonically increasing seq
// ---------------------------------------------------------------------------

describe("append — monotonic seq", () => {
  test("first entry gets seq 1", async () => {
    const j = new Journal(journalPath(), { now: fixedClock(1000) });
    const entry = await j.append({ type: "step", data: "hello" });
    expect(entry.seq).toBe(1);
  });

  test("subsequent entries increment seq", async () => {
    const j = new Journal(journalPath(), { now: fixedClock(2000) });
    const a = await j.append({ type: "step", data: 1 });
    const b = await j.append({ type: "step", data: 2 });
    const c = await j.append({ type: "step", data: 3 });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(c.seq).toBe(3);
  });

  test("reopened journal continues from last seq", async () => {
    const path = journalPath();
    const j1 = new Journal(path, { now: fixedClock(1000) });
    await j1.append({ type: "step", data: "first" });
    await j1.append({ type: "step", data: "second" });
    await j1.close();

    // New Journal instance over the same file.
    const j2 = new Journal(path, { now: fixedClock(2000) });
    const entry = await j2.append({ type: "step", data: "third" });
    expect(entry.seq).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Suite: readAll round-trips
// ---------------------------------------------------------------------------

describe("readAll — round-trip", () => {
  test("returns all appended entries in order", async () => {
    const j = new Journal(journalPath(), { now: fixedClock(999) });
    await j.append({ type: "a", key: "k1", label: "Alpha", data: { x: 1 } });
    await j.append({ type: "b", key: "k2", data: [1, 2, 3] });
    await j.append({ type: "c", data: null });

    const all = await j.readAll();
    expect(all.length).toBe(3);

    expect(all[0]).toMatchObject({ seq: 1, type: "a", key: "k1", label: "Alpha", data: { x: 1 }, ts: 999 });
    expect(all[1]).toMatchObject({ seq: 2, type: "b", key: "k2", data: [1, 2, 3], ts: 999 });
    expect(all[2]).toMatchObject({ seq: 3, type: "c", data: null, ts: 999 });
  });

  test("appended entry carries the ts from the injected clock", async () => {
    let tick = 100;
    const j = new Journal(journalPath(), { now: (): number => (tick += 10) });
    const e1 = await j.append({ type: "t", data: null });
    const e2 = await j.append({ type: "t", data: null });
    expect(e1.ts).toBe(110);
    expect(e2.ts).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// Suite: findByKey — resume primitive
// ---------------------------------------------------------------------------

describe("findByKey — resume lookup", () => {
  test("returns the matching entry", async () => {
    const j = new Journal(journalPath(), { now: fixedClock(42) });
    await j.append({ type: "agent", key: "step:plan", data: { result: "plan-output" } });
    await j.append({ type: "agent", key: "step:code", data: { result: "code-output" } });

    const found = await j.findByKey("step:plan");
    expect(found).not.toBeNull();
    expect(found?.key).toBe("step:plan");
    expect(found?.data).toMatchObject({ result: "plan-output" });
  });

  test("returns null when key is absent", async () => {
    const j = new Journal(journalPath(), { now: fixedClock(0) });
    await j.append({ type: "step", key: "existing", data: {} });

    const found = await j.findByKey("missing");
    expect(found).toBeNull();
  });

  test("returns the last entry when the same key appears multiple times", async () => {
    const j = new Journal(journalPath(), { now: fixedClock(0) });
    await j.append({ type: "step", key: "retry", data: "first-attempt" });
    await j.append({ type: "step", key: "retry", data: "second-attempt" });

    const found = await j.findByKey("retry");
    expect(found?.data).toBe("second-attempt");
    expect(found?.seq).toBe(2);
  });

  test("returns null for entries without a key field", async () => {
    const j = new Journal(journalPath(), { now: fixedClock(0) });
    // Append an entry with no key — findByKey must not match undefined === "k".
    await j.append({ type: "log", data: "no key here" });

    const found = await j.findByKey("k");
    expect(found).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Suite: missing file → []
// ---------------------------------------------------------------------------

describe("readAll — missing file", () => {
  test("returns empty array when the journal file does not exist", async () => {
    const j = new Journal(journalPath("does-not-exist.jsonl"));
    const all = await j.readAll();
    expect(all).toEqual([]);
  });

  test("findByKey returns null when file does not exist", async () => {
    const j = new Journal(journalPath("does-not-exist.jsonl"));
    const found = await j.findByKey("anything");
    expect(found).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Suite: malformed lines are skipped defensively
// ---------------------------------------------------------------------------

describe("readAll — malformed line skipping", () => {
  test("skips non-JSON lines and returns the valid ones", async () => {
    const path = journalPath();
    // Write a mix of valid and invalid JSONL lines directly.
    await writeFile(
      path,
      [
        JSON.stringify({ seq: 1, type: "ok", data: "good", ts: 1 }),
        "NOT JSON AT ALL",
        JSON.stringify({ seq: 2, type: "ok", data: "also-good", ts: 2 }),
        "",
        '{"incomplete": true',
        JSON.stringify({ seq: 3, type: "ok", data: "last", ts: 3 }),
      ].join("\n") + "\n",
    );

    const j = new Journal(path);
    const all = await j.readAll();
    expect(all.length).toBe(3);
    expect(all[0]?.data).toBe("good");
    expect(all[1]?.data).toBe("also-good");
    expect(all[2]?.data).toBe("last");
  });

  test("skips JSON objects that are missing required fields", async () => {
    const path = journalPath();
    await writeFile(
      path,
      [
        JSON.stringify({ seq: 1, type: "valid", data: "yes", ts: 10 }),
        // Missing `ts` — not a valid JournalEntry.
        JSON.stringify({ seq: 2, type: "invalid" }),
        // Missing `seq`.
        JSON.stringify({ type: "invalid", data: "x", ts: 20 }),
        JSON.stringify({ seq: 3, type: "valid", data: "yes-too", ts: 30 }),
      ].join("\n") + "\n",
    );

    const j = new Journal(path);
    const all = await j.readAll();
    expect(all.length).toBe(2);
    expect(all[0]?.seq).toBe(1);
    expect(all[1]?.seq).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Suite: concurrent appends — no corruption
// ---------------------------------------------------------------------------

describe("concurrent appends — integrity", () => {
  test("all Promise.all appends land without JSONL corruption", async () => {
    const j = new Journal(journalPath(), { now: fixedClock(5000) });

    const COUNT = 20;
    const results = await Promise.all(
      Array.from({ length: COUNT }, (_, i) =>
        j.append({ type: "concurrent", key: `step-${i}`, data: { index: i } }),
      ),
    );

    // Every returned entry must have a unique seq.
    const seqs = results.map((e) => e.seq).sort((a, b) => a - b);
    expect(seqs.length).toBe(COUNT);
    // Seqs must be a contiguous range 1..COUNT (no gaps, no duplicates).
    for (let i = 0; i < COUNT; i++) {
      expect(seqs[i]).toBe(i + 1);
    }

    // The file must parse as COUNT valid JSONL lines.
    await j.close();
    const all = await j.readAll();
    expect(all.length).toBe(COUNT);

    // Every index value must appear exactly once.
    const indices = new Set(all.map((e) => (e.data as { index: number }).index));
    expect(indices.size).toBe(COUNT);
  });

  test("sequential appends from a second journal instance continue seq correctly", async () => {
    // One agent pre-populates the journal; a second (e.g. after process restart)
    // reopens the same file and continues appending without overwriting.
    const path = journalPath();
    const j1 = new Journal(path, { now: fixedClock(1) });
    await j1.append({ type: "agent-1", data: "a" });
    await j1.append({ type: "agent-1", data: "b" });
    await j1.close();

    const j2 = new Journal(path, { now: fixedClock(2) });
    await j2.append({ type: "agent-2", data: "c" });
    await j2.append({ type: "agent-2", data: "d" });
    await j2.close();

    const all = await j2.readAll();
    // All 4 entries must be present with contiguous seqs.
    expect(all.length).toBe(4);
    const seqs = all.map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3, 4]);

    const types = all.map((e) => e.type);
    expect(types.filter((t) => t === "agent-1").length).toBe(2);
    expect(types.filter((t) => t === "agent-2").length).toBe(2);
  });
});

describe("Journal — write-failure resilience", () => {
  test("a transient write failure does not poison the queue and does not desync seq", async () => {
    const jpath = join(testDir, "j.jsonl");
    // Force the first write to fail deterministically: make the journal path a
    // directory so Bun.write/readLines error. Then remove it so the next write
    // succeeds — simulating a transient EIO/ENOSPC that later clears.
    await mkdir(jpath, { recursive: true });
    const j = new Journal(jpath);

    await expect(j.append({ type: "a", label: "a", data: { i: 1 } })).rejects.toBeDefined();

    await rm(jpath, { recursive: true, force: true });

    // With the bug the queue was permanently rejected and this would throw the
    // stale error (and never persist); it must now succeed.
    const ok = await j.append({ type: "b", label: "b", data: { i: 2 } });
    expect(ok.type).toBe("b");

    const all = await j.readAll();
    expect(all.length).toBe(1);
    expect(all[0]!.data).toEqual({ i: 2 });
    // seq did NOT advance on the failed append, so the survivor is seq 1.
    expect(all[0]!.seq).toBe(1);
  });
});
