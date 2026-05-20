import { describe, test, expect, beforeEach } from "bun:test";
import { z } from "zod";
import { buildTool, registerTool, getTool, getAllTools, clearTools, findToolByName } from "../src/tools/index.js";
import type { ToolUseContext, ToolPermissionContext } from "../src/tools/types.js";

const defaultContext: ToolUseContext = {
  abortController: new AbortController(),
  workingDir: "/tmp",
  readFileState: new Map(),
  permissionContext: {
    mode: "bypass",
    allowedTools: new Set(),
    deniedTools: new Set(),
    workingDir: "/tmp",
  },
};

describe("buildTool", () => {
  test("creates a tool with minimal definition", () => {
    const tool = buildTool({
      name: "echo",
      description: "Echo back the input",
      inputSchema: z.object({ message: z.string() }),
      call: async (input) => ({ content: input.message }),
    });

    expect(tool.name).toBe("echo");
    expect(tool.description).toBe("Echo back the input");
    expect(tool.isEnabled()).toBe(true);
    expect(tool.isReadOnly({ message: "test" })).toBe(false);
    expect(tool.isConcurrencySafe({ message: "test" })).toBe(false);
    expect(tool.isDestructive({ message: "test" })).toBe(false);
    expect(tool.userFacingName({ message: "test" })).toBe("echo");
  });

  test("tool call executes and returns result", async () => {
    const tool = buildTool({
      name: "echo",
      description: "Echo back the input",
      inputSchema: z.object({ message: z.string() }),
      call: async (input) => ({ content: `Echo: ${input.message}` }),
    });

    const result = await tool.call({ message: "hello" }, defaultContext);
    expect(result.content).toBe("Echo: hello");
    expect(result.isError).toBeUndefined();
  });

  test("tool validates input through schema", () => {
    const tool = buildTool({
      name: "add",
      description: "Add two numbers",
      inputSchema: z.object({
        a: z.number(),
        b: z.number(),
      }),
      call: async (input) => ({ content: input.a + input.b }),
    });

    const valid = tool.inputSchema.safeParse({ a: 1, b: 2 });
    expect(valid.success).toBe(true);

    const invalid = tool.inputSchema.safeParse({ a: "not a number" });
    expect(invalid.success).toBe(false);
  });

  test("custom overrides replace defaults", () => {
    const tool = buildTool({
      name: "safe_reader",
      description: "A read-only tool",
      inputSchema: z.object({ path: z.string() }),
      call: async () => ({ content: "" }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    });

    expect(tool.isReadOnly({ path: "/tmp" })).toBe(true);
    expect(tool.isConcurrencySafe({ path: "/tmp" })).toBe(true);
  });

  test("custom checkPermissions override", async () => {
    const tool = buildTool({
      name: "dangerous",
      description: "A destructive tool",
      inputSchema: z.object({ target: z.string() }),
      call: async () => ({ content: "done" }),
      isDestructive: () => true,
      checkPermissions: async (_input, _ctx) => ({
        behavior: "ask" as const,
        reason: "This tool is destructive",
      }),
    });

    const result = await tool.checkPermissions({ target: "/etc/passwd" }, defaultContext.permissionContext);
    expect(result.behavior).toBe("ask");
    expect(result.reason).toBe("This tool is destructive");
  });

  test("renderResult uses default implementation", () => {
    const tool = buildTool({
      name: "test",
      description: "Test tool",
      inputSchema: z.object({}),
      call: async () => ({ content: "hello" }),
    });

    const blocks = tool.renderResult({ content: "hello" });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: "text", text: "hello" });
  });

  test("tool with aliases", () => {
    const tool = buildTool({
      name: "file_read",
      description: "Read a file",
      inputSchema: z.object({ path: z.string() }),
      aliases: ["read", "cat"],
      call: async () => ({ content: "" }),
    });

    expect(tool.aliases).toEqual(["read", "cat"]);
  });
});

describe("tool registry", () => {
  beforeEach(() => {
    clearTools();
  });

  test("register and retrieve tool", () => {
    const tool = buildTool({
      name: "bash",
      description: "Execute shell commands",
      inputSchema: z.object({ command: z.string() }),
      call: async () => ({ content: "" }),
    });

    registerTool(tool);
    expect(getTool("bash")).toBe(tool);
  });

  test("list all registered tools", () => {
    const tool1 = buildTool({
      name: "bash",
      description: "Execute shell commands",
      inputSchema: z.object({ command: z.string() }),
      call: async () => ({ content: "" }),
    });
    const tool2 = buildTool({
      name: "read",
      description: "Read files",
      inputSchema: z.object({ path: z.string() }),
      call: async () => ({ content: "" }),
    });

    registerTool(tool1);
    registerTool(tool2);

    const all = getAllTools();
    expect(all).toHaveLength(2);
    expect(all.map((t) => t.name).sort()).toEqual(["bash", "read"]);
  });

  test("findToolByName finds by alias", () => {
    const tool = buildTool({
      name: "file_read",
      description: "Read files",
      inputSchema: z.object({ path: z.string() }),
      aliases: ["read"],
      call: async () => ({ content: "" }),
    });

    registerTool(tool);
    const tools = getAllTools();
    expect(findToolByName(tools, "file_read")).toBe(tool);
    expect(findToolByName(tools, "read")).toBe(tool);
    expect(findToolByName(tools, "write")).toBeUndefined();
  });

  test("getTool returns undefined for unregistered tool", () => {
    expect(getTool("nonexistent")).toBeUndefined();
  });

  test("tool is retrievable by alias", () => {
    const tool = buildTool({
      name: "file_write",
      description: "Write files",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      aliases: ["write"],
      call: async () => ({ content: "" }),
    });

    registerTool(tool);
    expect(getTool("write")).toBe(tool);
  });
});
