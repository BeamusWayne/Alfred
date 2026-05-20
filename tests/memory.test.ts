import { describe, test, expect, beforeEach } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { MemoryStore } from "../src/memory/store.js";
import { searchMemories } from "../src/memory/search.js";
import { fenceMemoryContext, stripMemoryFences } from "../src/memory/index.js";
import { memoryCreateTool, memorySearchTool, memoryDeleteTool } from "../src/tools/memoryTool.js";

const TMP_DIR = "/tmp/alfred-memory-test";

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

describe("memory store", () => {
  test("create a memory entry", async () => {
    const store = new MemoryStore(TMP_DIR);
    const entry = await store.create({
      name: "user-role",
      type: "user",
      description: "User is a data scientist",
      content: "User works as a data scientist focused on ML pipelines.",
    });
    expect(entry.name).toBe("user-role");
    expect(entry.type).toBe("user");
  });

  test("list memory entries", async () => {
    const store = new MemoryStore(TMP_DIR);
    await store.create({ name: "a", type: "user", description: "A", content: "Content A" });
    await store.create({ name: "b", type: "feedback", description: "B", content: "Content B" });
    const entries = await store.list();
    expect(entries).toHaveLength(2);
  });

  test("get a specific memory", async () => {
    const store = new MemoryStore(TMP_DIR);
    await store.create({ name: "test", type: "project", description: "Test", content: "Test content" });
    const entry = await store.get("test");
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe("Test content");
  });

  test("get nonexistent memory returns null", async () => {
    const store = new MemoryStore(TMP_DIR);
    expect(await store.get("nope")).toBeNull();
  });

  test("delete a memory", async () => {
    const store = new MemoryStore(TMP_DIR);
    await store.create({ name: "to-delete", type: "user", description: "Delete me", content: "Bye" });
    const deleted = await store.delete("to-delete");
    expect(deleted).toBe(true);
    expect(await store.get("to-delete")).toBeNull();
  });

  test("delete nonexistent returns false", async () => {
    const store = new MemoryStore(TMP_DIR);
    expect(await store.delete("ghost")).toBe(false);
  });
});

describe("memory search", () => {
  test("search finds matching memories", async () => {
    const store = new MemoryStore(TMP_DIR);
    await store.create({ name: "lang-go", type: "user", description: "Go expert", content: "User has 10 years of Go experience" });
    await store.create({ name: "lang-rust", type: "user", description: "Rust newbie", content: "User is learning Rust" });

    const results = await searchMemories(TMP_DIR, "Go");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.name === "lang-go")).toBe(true);
  });

  test("search returns empty for no matches", async () => {
    const store = new MemoryStore(TMP_DIR);
    await store.create({ name: "a", type: "user", description: "A", content: "Content about cats" });
    const results = await searchMemories(TMP_DIR, "quantum physics");
    expect(results).toEqual([]);
  });
});

describe("memory tools", () => {
  const context = {
    abortController: new AbortController(),
    workingDir: "/tmp",
    readFileState: new Map(),
    permissionContext: {
      mode: "bypass" as const,
      allowedTools: new Set(),
      deniedTools: new Set(),
      workingDir: "/tmp",
    },
  };

  test("memory create tool", async () => {
    const result = await memoryCreateTool.call(
      { name: "pref-1", type: "user", description: "Prefers dark mode", content: "User prefers dark theme in editors" },
      { ...context, memoryDir: TMP_DIR },
    );
    expect(result.content).toContain("pref-1");
    expect(result.isError).toBeFalsy();
  });

  test("memory search tool", async () => {
    const store = new MemoryStore(TMP_DIR);
    await store.create({ name: "test", type: "feedback", description: "No mocks", content: "Don't use mocks for database tests" });

    const result = await memorySearchTool.call(
      { query: "mocks" },
      { ...context, memoryDir: TMP_DIR },
    );
    expect(result.content).toContain("mocks");
  });

  test("memory delete tool", async () => {
    const store = new MemoryStore(TMP_DIR);
    await store.create({ name: "old", type: "project", description: "Old info", content: "Outdated info" });

    const result = await memoryDeleteTool.call(
      { name: "old" },
      { ...context, memoryDir: TMP_DIR },
    );
    expect(result.content).toContain("deleted");
  });

  test("memory delete nonexistent tool", async () => {
    const result = await memoryDeleteTool.call(
      { name: "ghost" },
      { ...context, memoryDir: TMP_DIR },
    );
    expect(result.isError).toBe(true);
  });
});

describe("context fencing", () => {
  test("fence wraps content in memory-context tags", () => {
    const fenced = fenceMemoryContext("User prefers dark mode");
    expect(fenced).toContain("<memory-context>");
    expect(fenced).toContain("User prefers dark mode");
    expect(fenced).toContain("</memory-context>");
    expect(fenced).toContain("NOT new user input");
  });

  test("fence returns empty for empty input", () => {
    expect(fenceMemoryContext("")).toBe("");
    expect(fenceMemoryContext("   ")).toBe("");
  });

  test("strip removes fenced blocks", () => {
    const text = "Hello <memory-context>secret data</memory-context> world";
    expect(stripMemoryFences(text)).toBe("Hello  world");
  });

  test("strip is case-insensitive", () => {
    const text = "Hello <MEMORY-CONTEXT>secret</MEMORY-CONTEXT> world";
    expect(stripMemoryFences(text)).toBe("Hello  world");
  });
});
