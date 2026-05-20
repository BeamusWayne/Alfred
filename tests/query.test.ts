import { describe, test, expect, beforeEach } from "bun:test";
import { z } from "zod";
import { query } from "../src/query/index.js";
import type { QueryConfig, QueryEvent, QueryState } from "../src/query/types.js";
import type { ToolUseContext } from "../src/tools/types.js";
import { registerTool, clearTools } from "../src/tools/index.js";
import { buildTool } from "../src/tools/types.js";
import type { Provider, LLMResponse, Message, ToolDefinition, ProviderConfig } from "../src/providers/types.js";
import { registerProvider as registerLLMProvider } from "../src/providers/index.js";

function createMockProvider(responses: LLMResponse[]): Provider {
  let callIndex = 0;
  return {
    name: "mock",
    chat: async (): Promise<LLMResponse> => {
      if (callIndex >= responses.length) {
        return {
          content: [{ type: "text", text: "No more responses" }],
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 20 },
          model: "mock-model",
        };
      }
      return responses[callIndex++];
    },
    stream: async function* () {
      return responses[0] ?? { content: [], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "mock" };
    },
    countTokens: async () => 0,
  };
}

function makeContext(): ToolUseContext {
  return {
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
}

async function collectEvents(
  gen: AsyncGenerator<QueryEvent, QueryState>,
  events: QueryEvent[],
): Promise<QueryState> {
  let state: QueryState = { messages: [], turnCount: 0, totalUsage: { inputTokens: 0, outputTokens: 0 } };
  while (true) {
    const result = await gen.next();
    if (result.done) { state = result.value; break; }
    events.push(result.value);
  }
  return state;
}

describe("query engine", () => {
  beforeEach(() => {
    clearTools();
  });

  test("simple text response without tools", async () => {
    registerLLMProvider("mock", () => createMockProvider([
      {
        content: [{ type: "text", text: "Hello! I am Alfred." }],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 20 },
        model: "mock-model",
      },
    ]));

    const events: QueryEvent[] = [];
    const state = await collectEvents(
      query("Hello", { provider: "mock", model: "mock-model", maxTurns: 5 }, makeContext()),
      events,
    );

    expect(events.map((e) => e.type)).toEqual(["text", "done"]);
    expect(events[0].text).toBe("Hello! I am Alfred.");
    expect(state.turnCount).toBe(1);
  });

  test("tool call + result + final response", async () => {
    registerTool(buildTool({
      name: "echo",
      description: "Echo back input",
      inputSchema: z.object({ message: z.string() }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: async (input) => ({ content: `Echo: ${input.message}` }),
    }));

    registerLLMProvider("mock", () => createMockProvider([
      {
        content: [
          { type: "text", text: "Let me echo that:" },
          { type: "tool_use", id: "tu_1", name: "echo", input: { message: "hello world" } },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 50, outputTokens: 30 },
        model: "mock-model",
      },
      {
        content: [{ type: "text", text: "The echo returned: Echo: hello world" }],
        stopReason: "end_turn",
        usage: { inputTokens: 60, outputTokens: 20 },
        model: "mock-model",
      },
    ]));

    const events: QueryEvent[] = [];
    const state = await collectEvents(
      query("Echo hello world", { provider: "mock", model: "mock-model", maxTurns: 5 }, makeContext()),
      events,
    );

    expect(events.map((e) => e.type)).toEqual([
      "text", "tool_use", "tool_result", "text", "done",
    ]);
    expect(state.turnCount).toBe(2);
    expect(state.totalUsage.inputTokens).toBe(110);
    expect(state.totalUsage.outputTokens).toBe(50);
  });

  test("unknown tool returns error", async () => {
    registerLLMProvider("mock", () => createMockProvider([
      {
        content: [{ type: "tool_use", id: "tu_1", name: "nonexistent_tool", input: {} }],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 10 },
        model: "mock-model",
      },
      {
        content: [{ type: "text", text: "Tool not found." }],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 10 },
        model: "mock-model",
      },
    ]));

    const events: QueryEvent[] = [];
    await collectEvents(
      query("Use fake tool", { provider: "mock", model: "mock-model", maxTurns: 5 }, makeContext()),
      events,
    );

    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult?.toolOutput).toContain("Unknown tool");
  });

  test("max turns limit", async () => {
    registerTool(buildTool({
      name: "loop_tool",
      description: "A tool",
      inputSchema: z.object({}),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: async () => ({ content: "looping" }),
    }));

    // Provider that always returns tool_use (infinite loop)
    const loopingProvider: Provider = {
      name: "mock",
      chat: async () => ({
        content: [{ type: "tool_use", id: `tu_${Date.now()}`, name: "loop_tool", input: {} }],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 10 },
        model: "mock-model",
      }),
      stream: async function* () {
        return { content: [], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "mock" };
      },
      countTokens: async () => 0,
    };
    registerLLMProvider("mock_loop", () => loopingProvider);

    const events: QueryEvent[] = [];
    const state = await collectEvents(
      query("Loop", { provider: "mock_loop", model: "mock-model", maxTurns: 3 }, makeContext()),
      events,
    );

    expect(state.turnCount).toBe(3);
    const err = events.find((e) => e.type === "error");
    expect(err?.error).toContain("Max turns");
  });

  test("API error is reported", async () => {
    registerLLMProvider("mock", () => ({
      name: "mock",
      chat: async () => { throw new Error("API key invalid"); },
      stream: async function* () { throw new Error("API key invalid"); },
      countTokens: async () => 0,
    }));

    const events: QueryEvent[] = [];
    await collectEvents(
      query("Hello", { provider: "mock", model: "mock-model", maxTurns: 5 }, makeContext()),
      events,
    );

    expect(events[0].type).toBe("error");
    expect(events[0].error).toContain("API key invalid");
  });
});
