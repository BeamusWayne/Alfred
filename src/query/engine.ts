import type { Message, ContentBlock, LLMResponse, ToolDefinition, ProviderConfig } from "../providers/types.js";
import { getProvider } from "../providers/index.js";
import type { Tool, ToolUseContext, ToolResult } from "../tools/types.js";
import { getAllTools, findToolByName } from "../tools/index.js";
import { evaluatePermission } from "../permissions/index.js";
import type { QueryConfig, QueryEvent, QueryState } from "./types.js";

const DEFAULT_MAX_TURNS = 50;

export async function* query(
  userMessage: string,
  config: QueryConfig,
  toolContext: ToolUseContext,
): AsyncGenerator<QueryEvent, QueryState> {
  const provider = getProvider(config.provider);
  const tools = getAllTools();

  const state: QueryState = {
    messages: [],
    turnCount: 0,
    totalUsage: { inputTokens: 0, outputTokens: 0 },
  };

  state.messages.push({ role: "user", content: userMessage });

  const providerConfig: ProviderConfig = {
    model: config.model,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    systemPrompt: config.systemPrompt,
  };

  const toolDefs: ToolDefinition[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));

  while (state.turnCount < (config.maxTurns || DEFAULT_MAX_TURNS)) {
    state.turnCount++;

    let response: LLMResponse;
    try {
      response = await provider.chat(state.messages, toolDefs, providerConfig);
    } catch (err) {
      yield { type: "error", error: err instanceof Error ? err.message : String(err) };
      return state;
    }

    state.totalUsage.inputTokens += response.usage.inputTokens;
    state.totalUsage.outputTokens += response.usage.outputTokens;

    for (const block of response.content) {
      if (block.type === "text") {
        yield { type: "text", text: block.text };
      }
    }

    if (response.stopReason !== "tool_use") {
      state.messages.push({ role: "assistant", content: response.content });
      yield { type: "done" };
      return state;
    }

    const toolUseBlocks = response.content.filter(
      (b): b is ContentBlock & { type: "tool_use" } => b.type === "tool_use",
    );

    state.messages.push({ role: "assistant", content: response.content });

    const { parallel, serial } = partitionToolCalls(toolUseBlocks, tools);

    if (parallel.length > 0) {
      const results = await Promise.all(
        parallel.map((tc) => executeToolCall(tc, tools, toolContext)),
      );
      for (const { call, result } of results) {
        yield* yieldToolResult(call, result, state);
      }
    }

    for (const tc of serial) {
      const { call, result } = await executeToolCall(tc, tools, toolContext);
      yield* yieldToolResult(call, result, state);
    }
  }

  yield { type: "error", error: `Max turns (${config.maxTurns}) reached` };
  return state;
}

function partitionToolCalls(
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  tools: readonly Tool[],
): { parallel: typeof toolCalls; serial: typeof toolCalls } {
  const parallel: typeof toolCalls = [];
  const serial: typeof toolCalls = [];

  for (const tc of toolCalls) {
    const tool = findToolByName(tools, tc.name);
    if (tool && tool.isReadOnly(tc.input) && tool.isConcurrencySafe(tc.input)) {
      parallel.push(tc);
    } else {
      serial.push(tc);
    }
  }

  return { parallel, serial };
}

async function executeToolCall(
  call: { id: string; name: string; input: Record<string, unknown> },
  tools: readonly Tool[],
  context: ToolUseContext,
): Promise<{ call: typeof call; result: ToolResult }> {
  const tool = findToolByName(tools, call.name);

  if (!tool) {
    return { call, result: { content: `Unknown tool: ${call.name}`, isError: true } };
  }

  const parsed = tool.inputSchema.safeParse(call.input);
  if (!parsed.success) {
    return { call, result: { content: `Invalid input for ${call.name}: ${parsed.error.message}`, isError: true } };
  }

  const permResult = await evaluatePermission(
    call.name,
    call.input,
    (input, ctx) => tool.checkPermissions(input, ctx),
    context.permissionContext,
  );

  if (permResult.behavior === "deny") {
    return { call, result: { content: `Permission denied: ${permResult.reason ?? "no reason given"}`, isError: true } };
  }

  if (permResult.behavior === "ask") {
    return { call, result: { content: `Tool '${call.name}' requires user approval (not yet implemented in non-interactive mode)`, isError: true } };
  }

  try {
    const result = await tool.call(parsed.data, context);
    return { call, result };
  } catch (err) {
    return { call, result: { content: `Tool error: ${err instanceof Error ? err.message : String(err)}`, isError: true } };
  }
}

async function* yieldToolResult(
  call: { id: string; name: string; input: Record<string, unknown> },
  result: ToolResult,
  state: QueryState,
): AsyncGenerator<QueryEvent, void> {
  yield { type: "tool_use", toolName: call.name, toolInput: call.input };

  const output = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
  yield { type: "tool_result", toolName: call.name, toolOutput: output };

  state.messages.push({
    role: "tool_result",
    toolUseId: call.id,
    content: output,
    isError: result.isError,
  });
}
