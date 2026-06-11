/**
 * Tests for the repo-map builder (ADR 0002).
 *
 * Fixtures live in an isolated temp directory; each suite creates its own
 * sub-directory and removes it on completion.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRepoMap } from "../src/context/repomap.ts";
import { extractSymbols, langFor } from "../src/context/lib/symbols.ts";
import { pageRank } from "../src/context/lib/pagerank.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "alfred-repomap-"));
}

// ---------------------------------------------------------------------------
// Unit: extractSymbols
// ---------------------------------------------------------------------------

describe("extractSymbols", () => {
  test("extracts exported function names as defs", () => {
    const src = `
export function doSomething() {}
export const myConst = 42;
export class MyClass {}
    `.trim();
    const { defs } = extractSymbols(src, "ts");
    expect(defs).toContain("doSomething");
    expect(defs).toContain("myConst");
    expect(defs).toContain("MyClass");
  });

  test("extracts top-level non-export function as def", () => {
    const src = `function helperFn() { return 1; }`;
    const { defs } = extractSymbols(src, "ts");
    expect(defs).toContain("helperFn");
  });

  test("extracts exported type and interface", () => {
    const src = `
export type UserId = string;
export interface UserRecord { id: UserId; }
    `.trim();
    const { defs } = extractSymbols(src, "ts");
    expect(defs).toContain("UserId");
    expect(defs).toContain("UserRecord");
  });

  test("refs do not include keywords", () => {
    const src = `
export function foo() {
  const x = true;
  return x;
}
    `.trim();
    const { refs } = extractSymbols(src, "ts");
    expect(refs).not.toContain("const");
    expect(refs).not.toContain("return");
    expect(refs).not.toContain("true");
  });

  test("refs do not include defs from the same file", () => {
    const src = `
export function bar() { return bar(); }
    `.trim();
    const { defs, refs } = extractSymbols(src, "ts");
    expect(defs).toContain("bar");
    expect(refs).not.toContain("bar");
  });

  test("refs include cross-file identifiers", () => {
    const src = `
import { UserId } from "./types.ts";
export function getUser(id: UserId) { return id; }
    `.trim();
    const { refs } = extractSymbols(src, "ts");
    expect(refs).toContain("UserId");
  });
});

// ---------------------------------------------------------------------------
// Unit: langFor
// ---------------------------------------------------------------------------

describe("langFor", () => {
  test("returns ts for .ts files", () => {
    expect(langFor("src/foo.ts")).toBe("ts");
    expect(langFor("src/bar.tsx")).toBe("ts");
  });

  test("returns js for .js files", () => {
    expect(langFor("src/foo.js")).toBe("js");
    expect(langFor("src/foo.mjs")).toBe("js");
  });

  test("returns null for non-source files", () => {
    expect(langFor("README.md")).toBeNull();
    expect(langFor("package.json")).toBeNull();
    expect(langFor("image.png")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unit: pageRank
// ---------------------------------------------------------------------------

describe("pageRank", () => {
  test("empty graph returns empty map", () => {
    const result = pageRank([], []);
    expect(result.size).toBe(0);
  });

  test("single node with no edges gets non-zero rank", () => {
    const result = pageRank(["a"], []);
    expect(result.get("a") ?? 0).toBeGreaterThan(0);
  });

  test("node pointed-to by many edges ranks higher", () => {
    // a, b, c all point to d; e points to a
    const nodes = ["a", "b", "c", "d", "e"];
    const edges = [
      { from: "a", to: "d", weight: 1 },
      { from: "b", to: "d", weight: 1 },
      { from: "c", to: "d", weight: 1 },
      { from: "e", to: "a", weight: 1 },
    ];
    const scores = pageRank(nodes, edges);
    const rankD = scores.get("d") ?? 0;
    const rankE = scores.get("e") ?? 0;
    expect(rankD).toBeGreaterThan(rankE);
  });

  test("is deterministic across calls", () => {
    const nodes = ["x", "y", "z"];
    const edges = [
      { from: "x", to: "y", weight: 2 },
      { from: "z", to: "y", weight: 1 },
    ];
    const r1 = pageRank(nodes, edges);
    const r2 = pageRank(nodes, edges);
    expect(r1.get("y")).toBe(r2.get("y"));
  });
});

// ---------------------------------------------------------------------------
// Integration: buildRepoMap
// ---------------------------------------------------------------------------

describe("buildRepoMap", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await makeTmpDir();

    // types.ts — defines UserId, UserRecord
    await writeFile(
      join(tmpDir, "types.ts"),
      [
        `export type UserId = string;`,
        `export interface UserRecord { id: UserId; name: string; }`,
      ].join("\n"),
    );

    // service.ts — references UserId and UserRecord (depends on types.ts)
    await writeFile(
      join(tmpDir, "service.ts"),
      [
        `import { UserId, UserRecord } from "./types.ts";`,
        `export function getUser(id: UserId): UserRecord {`,
        `  return { id, name: "test" };`,
        `}`,
      ].join("\n"),
    );

    // util.ts — standalone, no cross-file refs
    await writeFile(
      join(tmpDir, "util.ts"),
      [`export function noop() {}`, `export const VERSION = "1.0.0";`].join("\n"),
    );

    // node_modules with a .ts file that MUST be skipped
    await mkdir(join(tmpDir, "node_modules", "somelib"), { recursive: true });
    await writeFile(
      join(tmpDir, "node_modules", "somelib", "index.ts"),
      `export function vendorFn() { return 42; }`,
    );
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns a string with the repo map header", async () => {
    const map = await buildRepoMap(tmpDir);
    expect(map).toContain("## Repo map");
  });

  test("types.ts ranks highly because service.ts references its symbols", async () => {
    const map = await buildRepoMap(tmpDir, { tokenBudget: 4096 });
    const typesIdx = map.indexOf("types.ts");
    const utilIdx = map.indexOf("util.ts");
    // types.ts should appear before util.ts (higher rank)
    expect(typesIdx).toBeGreaterThanOrEqual(0);
    expect(typesIdx).toBeLessThan(utilIdx === -1 ? Infinity : utilIdx);
  });

  test("node_modules is skipped", async () => {
    const map = await buildRepoMap(tmpDir, { tokenBudget: 4096 });
    expect(map).not.toContain("vendorFn");
    expect(map).not.toContain("node_modules");
  });

  test("output respects the token budget", async () => {
    const budget = 64; // tiny budget → only first file or two
    const map = await buildRepoMap(tmpDir, { tokenBudget: budget });
    const charBudget = budget * 4;
    expect(map.length).toBeLessThanOrEqual(charBudget + 100); // small fudge for header
  });

  test("focusFiles boosts referenced target files", async () => {
    // Focus on service.ts; types.ts should rank even higher
    const mapFocused = await buildRepoMap(tmpDir, {
      tokenBudget: 4096,
      focusFiles: [join(tmpDir, "service.ts")],
    });
    expect(mapFocused).toContain("types.ts");
    // types.ts must appear before util.ts
    const ti = mapFocused.indexOf("types.ts");
    const ui = mapFocused.indexOf("util.ts");
    expect(ti).toBeGreaterThanOrEqual(0);
    if (ui !== -1) {
      expect(ti).toBeLessThan(ui);
    }
  });

  test("defined symbols appear in map output", async () => {
    const map = await buildRepoMap(tmpDir, { tokenBudget: 4096 });
    // At least one exported symbol should appear in the map
    const hasSymbol =
      map.includes("UserId") ||
      map.includes("UserRecord") ||
      map.includes("getUser") ||
      map.includes("noop");
    expect(hasSymbol).toBe(true);
  });
});
