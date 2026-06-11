/**
 * Tests for src/harness/featureList.ts
 *
 * ADR 0001 §5.3 / §7.7 (feature_list state machine)
 *
 * Covers: pickNext (deps + priority + skips non-pending), immutable transitions,
 * allResolved / counts, load/save round-trip, invalid JSON rejection.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Feature, FeatureList, FeatureStatus } from "../src/harness/featureList.ts";
import {
  allResolved,
  counts,
  loadFeatureList,
  markBlocked,
  markInProgress,
  markPassing,
  pickNext,
  saveFeatureList,
  setStatus,
} from "../src/harness/featureList.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFeature(overrides: Partial<Feature> & { id: string }): Feature {
  return {
    title: overrides.id,
    description: "",
    status: "pending",
    ...overrides,
  };
}

function makeList(features: Feature[]): FeatureList {
  return { features };
}

// ---------------------------------------------------------------------------
// pickNext
// ---------------------------------------------------------------------------

describe("pickNext", () => {
  test("returns null for an empty list", () => {
    expect(pickNext(makeList([]))).toBeNull();
  });

  test("returns null when all features are non-pending", () => {
    const list = makeList([
      makeFeature({ id: "a", status: "passing" }),
      makeFeature({ id: "b", status: "blocked" }),
      makeFeature({ id: "c", status: "in_progress" }),
    ]);
    expect(pickNext(list)).toBeNull();
  });

  test("returns the sole pending feature", () => {
    const f = makeFeature({ id: "a" });
    const list = makeList([f]);
    expect(pickNext(list)?.id).toBe("a");
  });

  test("skips features whose deps are not yet passing", () => {
    const list = makeList([makeFeature({ id: "b", deps: ["a"] }), makeFeature({ id: "a" })]);
    // "a" has no deps → eligible; "b" depends on "a" which is still pending
    expect(pickNext(list)?.id).toBe("a");
  });

  test("allows a feature whose dep is passing", () => {
    const list = makeList([
      makeFeature({ id: "a", status: "passing" }),
      makeFeature({ id: "b", deps: ["a"] }),
    ]);
    expect(pickNext(list)?.id).toBe("b");
  });

  test("blocks a feature whose dep is blocked (not passing)", () => {
    const list = makeList([
      makeFeature({ id: "a", status: "blocked" }),
      makeFeature({ id: "b", deps: ["a"] }),
    ]);
    expect(pickNext(list)).toBeNull();
  });

  test("all deps must be passing (partial is insufficient)", () => {
    const list = makeList([
      makeFeature({ id: "a", status: "passing" }),
      makeFeature({ id: "b", status: "pending" }),
      makeFeature({ id: "c", deps: ["a", "b"] }),
    ]);
    // "b" is pending → "c" not eligible; "b" itself has no deps so it is
    expect(pickNext(list)?.id).toBe("b");
  });

  test("picks lowest priority number first", () => {
    const list = makeList([
      makeFeature({ id: "high", priority: 10 }),
      makeFeature({ id: "low", priority: 1 }),
      makeFeature({ id: "mid", priority: 5 }),
    ]);
    expect(pickNext(list)?.id).toBe("low");
  });

  test("features without priority sort after those with priority", () => {
    const list = makeList([
      makeFeature({ id: "no-pri" }),
      makeFeature({ id: "has-pri", priority: 99 }),
    ]);
    expect(pickNext(list)?.id).toBe("has-pri");
  });

  test("stable ordering: ties broken by array position", () => {
    const list = makeList([
      makeFeature({ id: "first", priority: 1 }),
      makeFeature({ id: "second", priority: 1 }),
    ]);
    expect(pickNext(list)?.id).toBe("first");
  });

  test("stable ordering for no-priority: array position wins", () => {
    const list = makeList([makeFeature({ id: "first" }), makeFeature({ id: "second" })]);
    expect(pickNext(list)?.id).toBe("first");
  });
});

// ---------------------------------------------------------------------------
// setStatus / markInProgress / markPassing / markBlocked — immutability
// ---------------------------------------------------------------------------

describe("transitions — immutability", () => {
  test("setStatus returns a new list, original is unchanged", () => {
    const orig = makeList([makeFeature({ id: "a" })]);
    const updated = setStatus(orig, "a", "passing");

    expect(updated).not.toBe(orig);
    expect(updated.features[0]?.status).toBe("passing");
    // original untouched
    expect(orig.features[0]?.status).toBe("pending");
  });

  test("setStatus does not mutate the original feature object", () => {
    const origFeature = makeFeature({ id: "x" });
    const orig = makeList([origFeature]);
    setStatus(orig, "x", "in_progress");
    expect(origFeature.status).toBe("pending");
  });

  test("setStatus throws for unknown id", () => {
    const list = makeList([makeFeature({ id: "a" })]);
    expect(() => setStatus(list, "missing", "passing")).toThrow(/no feature with id "missing"/);
  });

  test("markInProgress sets status to in_progress", () => {
    const list = makeList([makeFeature({ id: "a" })]);
    expect(markInProgress(list, "a").features[0]?.status).toBe("in_progress");
  });

  test("markPassing sets status to passing", () => {
    const list = makeList([makeFeature({ id: "a" })]);
    expect(markPassing(list, "a").features[0]?.status).toBe("passing");
  });

  test("markBlocked sets status to blocked", () => {
    const list = makeList([makeFeature({ id: "a" })]);
    expect(markBlocked(list, "a").features[0]?.status).toBe("blocked");
  });

  test("unrelated features are not touched by setStatus", () => {
    const list = makeList([makeFeature({ id: "a" }), makeFeature({ id: "b" })]);
    const updated = setStatus(list, "a", "passing");
    expect(updated.features[1]?.status).toBe("pending");
    // same object reference for the untouched feature
    expect(updated.features[1]).toBe(list.features[1]);
  });

  test("chained transitions each produce a fresh list", () => {
    const l0 = makeList([makeFeature({ id: "a" }), makeFeature({ id: "b" })]);
    const l1 = markInProgress(l0, "a");
    const l2 = markPassing(l1, "a");
    const l3 = markBlocked(l2, "b");

    expect(l0.features[0]?.status).toBe("pending");
    expect(l1.features[0]?.status).toBe("in_progress");
    expect(l2.features[0]?.status).toBe("passing");
    expect(l3.features[1]?.status).toBe("blocked");
    expect(l3.features[0]?.status).toBe("passing");
  });
});

// ---------------------------------------------------------------------------
// allResolved / counts
// ---------------------------------------------------------------------------

describe("allResolved", () => {
  test("true for empty list", () => {
    expect(allResolved(makeList([]))).toBe(true);
  });

  test("true when all features are passing or blocked", () => {
    const list = makeList([
      makeFeature({ id: "a", status: "passing" }),
      makeFeature({ id: "b", status: "blocked" }),
    ]);
    expect(allResolved(list)).toBe(true);
  });

  test("false when any feature is pending", () => {
    const list = makeList([makeFeature({ id: "a", status: "passing" }), makeFeature({ id: "b" })]);
    expect(allResolved(list)).toBe(false);
  });

  test("false when any feature is in_progress", () => {
    const list = makeList([makeFeature({ id: "a", status: "in_progress" })]);
    expect(allResolved(list)).toBe(false);
  });
});

describe("counts", () => {
  test("all zeros for empty list", () => {
    expect(counts(makeList([]))).toEqual({
      pending: 0,
      in_progress: 0,
      passing: 0,
      blocked: 0,
    });
  });

  test("accurate counts across all statuses", () => {
    const statuses: FeatureStatus[] = [
      "pending",
      "pending",
      "in_progress",
      "passing",
      "passing",
      "passing",
      "blocked",
    ];
    const list = makeList(statuses.map((s, i) => makeFeature({ id: String(i), status: s })));
    expect(counts(list)).toEqual({
      pending: 2,
      in_progress: 1,
      passing: 3,
      blocked: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// IO — load/save round-trip
// ---------------------------------------------------------------------------

describe("loadFeatureList / saveFeatureList", () => {
  const tmpFiles: string[] = [];

  function tmpPath(name: string): string {
    const p = join(tmpdir(), `alfred-featureList-test-${Date.now()}-${name}.json`);
    tmpFiles.push(p);
    return p;
  }

  afterEach(async () => {
    await Promise.all(tmpFiles.splice(0).map((p) => rm(p, { force: true })));
  });

  test("round-trip: save then load returns equivalent data", async () => {
    const list: FeatureList = {
      features: [
        makeFeature({ id: "feat-1", priority: 1, deps: ["feat-0"] }),
        makeFeature({ id: "feat-0", status: "passing" }),
      ],
    };
    const path = tmpPath("roundtrip");
    await saveFeatureList(path, list);
    const loaded = await loadFeatureList(path);
    expect(loaded).toEqual(list);
  });

  test("saved file contains pretty-printed JSON", async () => {
    const list = makeList([makeFeature({ id: "a" })]);
    const path = tmpPath("pretty");
    await saveFeatureList(path, list);
    const text = await Bun.file(path).text();
    expect(text).toContain("\n"); // multi-line
    expect(text.endsWith("\n")).toBe(true);
  });

  test("loadFeatureList throws for a missing file", async () => {
    await expect(loadFeatureList("/tmp/alfred-does-not-exist-xyz.json")).rejects.toThrow(
      /file not found/,
    );
  });

  test("loadFeatureList throws for invalid JSON", async () => {
    const path = tmpPath("badjson");
    await Bun.write(path, "{ not valid json }}}");
    await expect(loadFeatureList(path)).rejects.toThrow(/invalid JSON/);
  });

  test("loadFeatureList throws with a clear message for schema violations", async () => {
    const path = tmpPath("badschema");
    // Missing required fields
    await Bun.write(path, JSON.stringify({ features: [{ id: 123 }] }, null, 2));
    await expect(loadFeatureList(path)).rejects.toThrow(/schema validation failed/);
  });

  test("loadFeatureList rejects an unknown status value", async () => {
    const path = tmpPath("badstatus");
    const bad = {
      features: [
        {
          id: "x",
          title: "x",
          description: "",
          status: "unknown-status",
        },
      ],
    };
    await Bun.write(path, JSON.stringify(bad, null, 2));
    await expect(loadFeatureList(path)).rejects.toThrow(/schema validation failed/);
  });

  test("loadFeatureList rejects non-object root", async () => {
    const path = tmpPath("nonobject");
    await Bun.write(path, JSON.stringify([1, 2, 3]));
    await expect(loadFeatureList(path)).rejects.toThrow(/schema validation failed/);
  });
});
