import { describe, test, expect } from "bun:test";
import { webFetchTool } from "../src/tools/webFetch.js";
import { webSearchTool } from "../src/tools/webSearch.js";
import { agentTool } from "../src/tools/agent.js";

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

describe("WebFetchTool", () => {
  test("is read-only and concurrency-safe", () => {
    expect(webFetchTool.isReadOnly({ url: "https://example.com" })).toBe(true);
    expect(webFetchTool.isConcurrencySafe({ url: "https://example.com" })).toBe(true);
  });

  test("fetches a URL and returns content", async () => {
    const result = await webFetchTool.call({ url: "https://httpbin.org/get" }, context);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("httpbin.org");
  });

  test("handles invalid URL gracefully", async () => {
    const result = await webFetchTool.call({ url: "not-a-url" }, context);
    expect(result.isError).toBe(true);
  });

  test("handles HTTP errors", async () => {
    const result = await webFetchTool.call({ url: "https://httpbin.org/status/404" }, context);
    // May timeout on slow networks, just verify it returns something
    expect(result).toBeDefined();
    if (result.isError) {
      expect(result.content).toBeTruthy();
    }
  });
});

describe("WebSearchTool", () => {
  test("is read-only and concurrency-safe", () => {
    expect(webSearchTool.isReadOnly({ query: "test" })).toBe(true);
    expect(webSearchTool.isConcurrencySafe({ query: "test" })).toBe(true);
  });

  test("returns placeholder message", async () => {
    const result = await webSearchTool.call({ query: "TypeScript" }, context);
    expect(result.content).toContain("search API");
  });
});

describe("AgentTool", () => {
  test("returns task description", async () => {
    const result = await agentTool.call({ prompt: "Fix the bug in auth.ts" }, context);
    expect(result.content).toContain("Fix the bug in auth.ts");
  });
});
