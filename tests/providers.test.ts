import { describe, test, expect } from "bun:test";
import { getProvider, listProviders, registerProvider } from "../src/providers/index.js";
import type { Provider, Message, ToolDefinition, ProviderConfig } from "../src/providers/types.js";
import { z } from "zod";

describe("provider registry", () => {
  test("lists registered providers", () => {
    const providers = listProviders();
    expect(providers).toContain("anthropic");
    expect(providers).toContain("openai");
  });

  test("getProvider returns provider instance", () => {
    const anthropic = getProvider("anthropic");
    expect(anthropic.name).toBe("anthropic");

    const openai = getProvider("openai");
    expect(openai.name).toBe("openai");
  });

  test("getProvider throws for unknown provider", () => {
    expect(() => getProvider("unknown")).toThrow("Unknown provider: unknown");
  });

  test("can register custom provider", () => {
    const customProvider: Provider = {
      name: "custom",
      chat: async () => ({ content: [], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "custom" }),
      stream: async function* () { return { content: [], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "custom" }; },
      countTokens: async () => 0,
    };
    registerProvider("custom", () => customProvider);
    expect(getProvider("custom")).toBe(customProvider);
  });

  test("switching providers does not require caller code changes", async () => {
    const anthropic = getProvider("anthropic");
    const openai = getProvider("openai");

    // Both providers implement the same interface
    expect(typeof anthropic.chat).toBe("function");
    expect(typeof anthropic.stream).toBe("function");
    expect(typeof anthropic.countTokens).toBe("function");
    expect(typeof openai.chat).toBe("function");
    expect(typeof openai.stream).toBe("function");
    expect(typeof openai.countTokens).toBe("function");

    // countTokens works for both without API keys
    const aTokens = await anthropic.countTokens("hello world");
    const oTokens = await openai.countTokens("hello world");
    expect(aTokens).toBeGreaterThan(0);
    expect(oTokens).toBeGreaterThan(0);
  });
});

describe("message types", () => {
  test("user message with string content", () => {
    const msg: Message = { role: "user", content: "hello" };
    expect(msg.role).toBe("user");
  });

  test("assistant message with content blocks", () => {
    const msg: Message = {
      role: "assistant",
      content: [
        { type: "text", text: "Hello!" },
        { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
      ],
    };
    if (msg.role === "assistant") {
      expect(msg.content).toHaveLength(2);
    }
  });

  test("tool result message", () => {
    const msg: Message = {
      role: "tool_result",
      toolUseId: "tu_1",
      content: "file1.txt\nfile2.txt",
    };
    expect(msg.role).toBe("tool_result");
  });
});

describe("tool definition", () => {
  test("can define tool with zod schema", () => {
    const tool: ToolDefinition = {
      name: "bash",
      description: "Execute a shell command",
      inputSchema: z.object({
        command: z.string().describe("The command to execute"),
        timeout: z.number().optional().describe("Timeout in ms"),
      }),
    };
    expect(tool.name).toBe("bash");

    const parsed = tool.inputSchema.safeParse({ command: "ls" });
    expect(parsed.success).toBe(true);
  });
});
