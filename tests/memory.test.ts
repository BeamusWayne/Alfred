/**
 * Tests for Memory v2 (ADR 0001 §4).
 *
 * Each test group uses an isolated temp dir so the suite is hermetic — no
 * writes to the repo or a real .alfred/ directory. Providers are closed and
 * temp dirs removed in afterEach.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EpisodeStore } from "../src/memory/episodes.ts";
import { LocalFileProvider } from "../src/memory/localFile.ts";
import type { Fact } from "../src/memory/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempRoot = "";
let provider: LocalFileProvider;

function uniqueDir(): string {
  return join(tmpdir(), `alfred-mem-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

async function makeProvider(root?: string): Promise<LocalFileProvider> {
  const r = root ?? tempRoot;
  await mkdir(r, { recursive: true });
  return new LocalFileProvider(r);
}

function fakeFact(overrides: Partial<Omit<Fact, "id">> = {}): Omit<Fact, "id"> {
  return {
    slug: "test-fact-" + Math.random().toString(36).slice(2, 8),
    type: "project",
    content: "Alfred uses Bun as its runtime.",
    ts: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tempRoot = uniqueDir();
  await mkdir(tempRoot, { recursive: true });
  provider = await makeProvider();
});

afterEach(async () => {
  provider.close();
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. upsert → get → search round-trip (FTS5)
// ---------------------------------------------------------------------------

describe("upsert → get → search", () => {
  test("upsert returns a Fact with correct fields", async () => {
    const candidate = fakeFact({ slug: "bun-runtime", content: "Project uses Bun runtime." });
    const fact = await provider.upsert(candidate);
    expect(fact.id).toBe("bun-runtime");
    expect(fact.slug).toBe("bun-runtime");
    expect(fact.type).toBe("project");
    expect(fact.content).toBe("Project uses Bun runtime.");
  });

  test("get retrieves the upserted fact", async () => {
    const candidate = fakeFact({ slug: "zod-validation", content: "Validation uses Zod schemas." });
    await provider.upsert(candidate);
    const retrieved = await provider.get("zod-validation");
    expect(retrieved).not.toBeNull();
    expect(retrieved?.slug).toBe("zod-validation");
    expect(retrieved?.content).toBe("Validation uses Zod schemas.");
  });

  test("get returns null for unknown slug", async () => {
    const result = await provider.get("nonexistent-slug");
    expect(result).toBeNull();
  });

  test("upsert is idempotent — second upsert overwrites", async () => {
    await provider.upsert(fakeFact({ slug: "my-fact", content: "Original content." }));
    await provider.upsert(fakeFact({ slug: "my-fact", content: "Updated content." }));
    const result = await provider.get("my-fact");
    expect(result?.content).toBe("Updated content.");
  });

  test("search finds fact by keyword (FTS5)", async () => {
    await provider.upsert(
      fakeFact({ slug: "typescript-strict", content: "Strict TypeScript mode is enabled." }),
    );
    await provider.upsert(
      fakeFact({ slug: "immutability-rule", content: "Never mutate inputs or existing objects." }),
    );

    const results = await provider.search("TypeScript");
    const slugs = results.map((f) => f.slug);
    expect(slugs).toContain("typescript-strict");
  });

  test("search returns empty array when no matches", async () => {
    await provider.upsert(fakeFact({ slug: "some-fact", content: "Bun is fast." }));
    const results = await provider.search("completelynonsenseterm9999");
    expect(results).toHaveLength(0);
  });

  test("forget removes fact and it cannot be retrieved", async () => {
    await provider.upsert(fakeFact({ slug: "to-delete", content: "Delete me." }));
    await provider.forget("to-delete");
    const retrieved = await provider.get("to-delete");
    expect(retrieved).toBeNull();
    const searched = await provider.search("Delete me");
    expect(searched.find((f) => f.slug === "to-delete")).toBeUndefined();
  });

  test("forget is a no-op for unknown slug", async () => {
    // Should not throw
    await provider.forget("definitely-not-there");
  });

  test("search across multiple facts returns all matching", async () => {
    await provider.upsert(fakeFact({ slug: "fact-a", content: "Alfred agent coding CLI." }));
    await provider.upsert(
      fakeFact({ slug: "fact-b", content: "Alfred uses streaming responses." }),
    );
    await provider.upsert(fakeFact({ slug: "fact-c", content: "Unrelated content about python." }));

    const results = await provider.search("Alfred");
    const slugs = results.map((f) => f.slug);
    expect(slugs).toContain("fact-a");
    expect(slugs).toContain("fact-b");
  });
});

// ---------------------------------------------------------------------------
// 2. Token-budgeted inject
// ---------------------------------------------------------------------------

describe("inject (token-budgeted Core)", () => {
  test("returns empty-ish MemoryBlock when no files exist", async () => {
    const block = await provider.inject();
    expect(typeof block.text).toBe("string");
    expect(block.estimatedTokens).toBeGreaterThanOrEqual(0);
    expect(block.truncated).toBe(false);
  });

  test("inject reflects USER.md content", async () => {
    const userPath = join(tempRoot, "USER.md");
    await writeFile(userPath, "User prefers TypeScript and Bun.\n");
    const block = await provider.inject();
    expect(block.text).toContain("TypeScript");
    expect(block.text).toContain("Bun");
  });

  test("inject reflects MEMORY.md content after upsert", async () => {
    await provider.upsert(fakeFact({ slug: "mem-test", content: "Memory index test fact." }));
    // MEMORY.md is rebuilt after upsert
    const block = await provider.inject();
    expect(block.text).toContain("mem-test");
  });

  test("inject truncates when content exceeds budget", async () => {
    // Write a huge MEMORY.md manually to force truncation
    const bigContent = "- [fact] project: " + "x".repeat(500) + "\n";
    const manyLines = bigContent.repeat(40); // ~24k chars >> 6000 char budget
    const memPath = join(tempRoot, "MEMORY.md");
    await writeFile(memPath, manyLines);

    const block = await provider.inject();
    // Budget is 1500 tokens = 6000 chars; the block must be within budget
    expect(block.estimatedTokens).toBeLessThanOrEqual(1500);
    expect(block.truncated).toBe(true);
  });

  test("inject is not truncated for normal content sizes", async () => {
    await writeFile(join(tempRoot, "USER.md"), "Prefer immutability.\n");
    await provider.upsert(fakeFact({ slug: "s1", content: "Short fact one." }));
    await provider.upsert(fakeFact({ slug: "s2", content: "Short fact two." }));
    const block = await provider.inject();
    expect(block.truncated).toBe(false);
    expect(block.estimatedTokens).toBeLessThanOrEqual(1500);
  });

  test("estimatedTokens matches chars/4 ceiling", async () => {
    await writeFile(join(tempRoot, "USER.md"), "Hello world.\n");
    const block = await provider.inject();
    // tokens should roughly be ceil(text.length / 4)
    const expected = Math.ceil(block.text.length / 4);
    expect(block.estimatedTokens).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 3. Staleness detection in extract()
// ---------------------------------------------------------------------------

describe("extract — staleness + GC", () => {
  test("extract removes expired TTL facts", async () => {
    const pastDate = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10); // yesterday
    await provider.upsert(
      fakeFact({ slug: "stale-fact", content: "This is stale.", ttl: pastDate }),
    );
    // Verify it's there before extract
    expect(await provider.get("stale-fact")).not.toBeNull();

    await provider.extract();

    // After extract, stale fact should be gone from recall
    expect(await provider.get("stale-fact")).toBeNull();
  });

  test("extract keeps facts with future TTL", async () => {
    const futureDate = new Date(Date.now() + 86_400_000 * 365).toISOString().slice(0, 10);
    await provider.upsert(
      fakeFact({ slug: "fresh-fact", content: "This is fresh.", ttl: futureDate }),
    );
    await provider.extract();
    expect(await provider.get("fresh-fact")).not.toBeNull();
  });

  test("extract removes facts whose scope path no longer exists", async () => {
    // Use an absolute path that definitely doesn't exist
    const ghostPath = join(tempRoot, "ghost-file.ts");
    await provider.upsert(
      fakeFact({ slug: "scoped-stale", content: "References ghost file.", scope: ghostPath }),
    );
    expect(await provider.get("scoped-stale")).not.toBeNull();

    await provider.extract();

    expect(await provider.get("scoped-stale")).toBeNull();
  });

  test("extract keeps facts whose scope path exists", async () => {
    const realFile = join(tempRoot, "real-file.ts");
    await writeFile(realFile, "// real");
    await provider.upsert(
      fakeFact({ slug: "scoped-live", content: "References real file.", scope: realFile }),
    );
    await provider.extract();
    expect(await provider.get("scoped-live")).not.toBeNull();
  });

  test("extract deduplicates identical facts by content+type", async () => {
    const content = "Exact duplicate content for dedup test.";
    // Write two facts with same type+content but different slugs
    await provider.upsert(fakeFact({ slug: "dup-a", type: "project", content }));
    // small delay to ensure different ts
    await Bun.sleep(2);
    await provider.upsert(fakeFact({ slug: "dup-b", type: "project", content }));

    await provider.extract();

    // One should remain, one should be archived
    const a = await provider.get("dup-a");
    const b = await provider.get("dup-b");
    const survivors = [a, b].filter(Boolean).length;
    expect(survivors).toBe(1);
  });

  test("extract is a no-op when facts dir is empty", async () => {
    // Should not throw
    await provider.extract();
  });
});

// ---------------------------------------------------------------------------
// 4. Episode write / query
// ---------------------------------------------------------------------------

describe("EpisodeStore", () => {
  let episodeDir = "";
  let store: EpisodeStore;

  beforeEach(() => {
    episodeDir = join(tempRoot, "episodes");
    store = new EpisodeStore(episodeDir);
  });

  test("write returns an Episode with id and ts", async () => {
    const ep = await store.write({
      goal: "Fix the bug in parser",
      approach: "Read the code, write tests, fix implementation",
      worked: ["Reading grep output"],
      failed: ["Using sed directly"],
    });
    expect(typeof ep.id).toBe("string");
    expect(ep.id.length).toBeGreaterThan(0);
    expect(typeof ep.ts).toBe("string");
    expect(ep.goal).toBe("Fix the bug in parser");
  });

  test("get retrieves a written episode", async () => {
    const written = await store.write({
      goal: "Implement feature X",
      approach: "TDD",
      worked: ["Writing tests first"],
      failed: [],
    });
    const retrieved = await store.get(written.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(written.id);
    expect(retrieved?.goal).toBe("Implement feature X");
  });

  test("get returns null for unknown id", async () => {
    const result = await store.get("not-a-real-id");
    expect(result).toBeNull();
  });

  test("list returns all episodes newest-first", async () => {
    const a = await store.write({ goal: "Alpha", approach: "a", worked: [], failed: [] });
    await Bun.sleep(2);
    const b = await store.write({ goal: "Beta", approach: "b", worked: [], failed: [] });

    const listed = await store.list();
    expect(listed.length).toBe(2);
    // Beta was written later, so it should come first (newest-first)
    expect(listed[0]?.id).toBe(b.id);
    expect(listed[1]?.id).toBe(a.id);
  });

  test("list respects limit", async () => {
    await store.write({ goal: "A", approach: "a", worked: [], failed: [] });
    await store.write({ goal: "B", approach: "b", worked: [], failed: [] });
    await store.write({ goal: "C", approach: "c", worked: [], failed: [] });
    const listed = await store.list(2);
    expect(listed.length).toBe(2);
  });

  test("list(limit) skips corrupt newest files and still returns valid older ones", async () => {
    const a = await store.write({ goal: "Alpha", approach: "a", worked: [], failed: [] });
    await Bun.sleep(2);
    const b = await store.write({ goal: "Beta", approach: "b", worked: [], failed: [] });
    // Files that sort NEWEST (lexicographically after ISO-timestamp ids) but are
    // unparsable. The old limit*2 window would scan only these and return [].
    for (let i = 0; i < 6; i++) {
      await writeFile(join(episodeDir, `9999-corrupt-${i}.json`), "{ not valid json", "utf-8");
    }
    const listed = await store.list(2);
    expect(listed.length).toBe(2);
    expect(listed.map((e) => e.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("query finds episodes by keyword", async () => {
    await store.write({
      goal: "Fix SQLite FTS bug",
      approach: "Debug index",
      worked: [],
      failed: [],
    });
    await store.write({
      goal: "Add new endpoint",
      approach: "REST design",
      worked: [],
      failed: [],
    });

    const results = await store.query(["SQLite"], 10);
    expect(results.length).toBe(1);
    expect(results[0]?.goal).toContain("SQLite");
  });

  test("query returns empty array when no match", async () => {
    await store.write({ goal: "Some goal", approach: "Some approach", worked: [], failed: [] });
    const results = await store.query(["zzznomatch"], 10);
    expect(results).toHaveLength(0);
  });

  test("delete removes an episode", async () => {
    const ep = await store.write({ goal: "To be deleted", approach: "x", worked: [], failed: [] });
    await store.delete(ep.id);
    const retrieved = await store.get(ep.id);
    expect(retrieved).toBeNull();
  });

  test("delete is a no-op for unknown id", async () => {
    // Should not throw
    await store.delete("nonexistent-episode-id");
  });

  test("write stores optional fields (gitSha, cost, verifyExit)", async () => {
    const ep = await store.write({
      goal: "Ship feature",
      approach: "CI/CD",
      worked: ["Tests pass"],
      failed: [],
      gitSha: "abc123",
      cost: 0.042,
      verifyExit: "All green",
    });
    const retrieved = await store.get(ep.id);
    expect(retrieved?.gitSha).toBe("abc123");
    expect(retrieved?.cost).toBe(0.042);
    expect(retrieved?.verifyExit).toBe("All green");
  });

  test("list returns empty array when episodes dir does not exist", async () => {
    const emptyStore = new EpisodeStore(join(tempRoot, "no-such-dir"));
    const result = await emptyStore.list();
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. contradict
// ---------------------------------------------------------------------------

describe("contradict", () => {
  test("returns the existing fact when slug matches", async () => {
    await provider.upsert(fakeFact({ slug: "conf-slug", type: "user", content: "Old value." }));
    const conflicts = await provider.contradict({
      slug: "conf-slug",
      type: "user",
      content: "New value.",
      ts: new Date().toISOString(),
    });
    expect(conflicts.find((f) => f.slug === "conf-slug")).toBeDefined();
  });

  test("returns empty array when no match", async () => {
    const conflicts = await provider.contradict({
      slug: "brand-new-slug-xyz",
      type: "reference",
      content: "Totally unique content here.",
      ts: new Date().toISOString(),
    });
    expect(conflicts.find((f) => f.slug === "brand-new-slug-xyz")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. prefetch
// ---------------------------------------------------------------------------

describe("prefetch", () => {
  test("returns up to k results", async () => {
    for (let i = 0; i < 5; i++) {
      await provider.upsert(
        fakeFact({ slug: `pf-fact-${i}`, content: `Prefetch test content item ${i}.` }),
      );
    }
    const results = await provider.prefetch("Prefetch test content", 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// slug path-traversal containment (ADR 0003)
// ---------------------------------------------------------------------------

describe("slug containment", () => {
  test("forget/get/upsert reject a traversal slug and never touch outside files", async () => {
    // A file living outside the facts dir (and outside the workspace root).
    const outside = join(
      tempRoot,
      "..",
      `outside-secret-${Math.random().toString(36).slice(2)}.md`,
    );
    await writeFile(outside, "do not delete", "utf8");
    try {
      await expect(provider.forget("../../foo")).rejects.toThrow(/invalid memory slug/);
      await expect(provider.get("../../foo")).rejects.toThrow(/invalid memory slug/);
      await expect(provider.upsert(fakeFact({ slug: "../../evil" }))).rejects.toThrow(
        /invalid memory slug/,
      );
      await expect(provider.forget("a/b")).rejects.toThrow(/invalid memory slug/);
      // The outside file must be untouched.
      expect(await Bun.file(outside).exists()).toBe(true);
    } finally {
      await rm(outside, { force: true });
    }
  });

  test("a legitimate slug with dots (no separators) is allowed", async () => {
    const f = await provider.upsert(fakeFact({ slug: "v1.2.3-config", content: "x" }));
    expect(f.slug).toBe("v1.2.3-config");
    expect((await provider.get("v1.2.3-config"))?.slug).toBe("v1.2.3-config");
  });
});
