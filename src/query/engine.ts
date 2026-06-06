/**
 * The agent loop: user message → model → (tools) → repeat until the model
 * stops asking for tools or a limit is hit. An async generator that yields
 * `QueryEvent`s and returns a typed `QueryState`.
 *
 * What it does that the old loop did not (per the review):
 *   - retries transient provider failures with backoff (yields `retrying`),
 *     escalating through the model fallback chain on each retry (ADR 0005);
 *   - returns a typed terminal status (success / max_turns / provider_error / aborted);
 *   - gates every tool through the permission evaluator, with an approval
 *     callback for `ask` (no more dead "ask" branch);
 *   - runs read-only + concurrency-safe tools in parallel, the rest serially;
 *   - compacts older context at a user boundary near the budget (ADR 0001 §7.4);
 *   - fences untrusted tool output (ADR 0003) and emits OTel GenAI spans plus
 *     a running token cost (ADR 0004).
 */
import {
  addUsage,
  ProviderError,
  ZERO_USAGE,
  type LLMResponse,
  type Message,
  type ToolDefinition,
  type Usage,
} from "../providers/types.ts";
import { z } from "zod";
import { getAllTools, findTool } from "../tools/index.ts";
import type { Tool, ToolContext } from "../tools/types.ts";
import { evaluatePermission } from "../permissions/evaluate.ts";
import { computeDelay, isRetryable, retryAfterMs, sleep } from "./retry.ts";
import type { ApprovalRequest, QueryConfig, QueryEvent, QueryState, TerminalStatus } from "./types.ts";
import { CostTracker } from "../cost/tracker.ts";
import {
  tracerFromEnv,
  GEN_AI_OPERATION_NAME,
  GEN_AI_SYSTEM,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_TOOL_NAME,
  type Tracer,
  type SpanHandle,
} from "../telemetry/otel.ts";
import { shouldCompact, compact } from "../compact/engine.ts";
import { fallbackChain } from "../config/roles.ts";
import { fence } from "../security/taint.ts";

const DEFAULT_MAX_TURNS = 50;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;

interface ToolUse {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

function toToolDefinition(tool: Tool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.inputSchema) as Record<string, unknown>,
  };
}

function parsedInput(tool: Tool, input: Record<string, unknown>): Record<string, unknown> | null {
  const parsed = tool.inputSchema.safeParse(input);
  return parsed.success ? (parsed.data as Record<string, unknown>) : null;
}

function isParallelizable(tools: readonly Tool[], use: ToolUse): boolean {
  const tool = findTool(tools, use.name);
  if (!tool) return false;
  const data = parsedInput(tool, use.input);
  if (data === null) return false;
  return tool.isReadOnly(data) && tool.isConcurrencySafe(data);
}

function describeUse(tools: readonly Tool[], use: ToolUse): string {
  const tool = findTool(tools, use.name);
  if (!tool) return use.name;
  const data = parsedInput(tool, use.input);
  return data === null ? use.name : tool.describeCall(data);
}

interface ToolOutcome {
  readonly use: ToolUse;
  readonly output: string;
  readonly isError: boolean;
}

async function executeTool(
  use: ToolUse,
  tools: readonly Tool[],
  ctx: ToolContext,
  tracer: Tracer,
  parentSpan: SpanHandle | undefined,
  approve?: (req: ApprovalRequest) => Promise<boolean>,
): Promise<ToolOutcome> {
  const tool = findTool(tools, use.name);
  if (!tool) return { use, output: `Unknown tool: ${use.name}`, isError: true };

  const parsed = tool.inputSchema.safeParse(use.input);
  if (!parsed.success) {
    return { use, output: `Invalid input for ${use.name}: ${parsed.error.message}`, isError: true };
  }
  const data = parsed.data as Record<string, unknown>;

  const decision = await evaluatePermission({
    toolName: use.name,
    isReadOnly: tool.isReadOnly(data),
    input: data,
    check: (input, pctx) => tool.checkPermissions(input, pctx),
    ctx: ctx.permissions,
  });

  if (decision.behavior === "deny") {
    return { use, output: `Permission denied: ${decision.reason ?? "no reason"}`, isError: true };
  }
  if (decision.behavior === "ask") {
    const ok = approve
      ? await approve({
          toolName: use.name,
          description: tool.describeCall(data),
          reason: decision.reason,
          input: data,
        })
      : false;
    if (!ok) {
      const why = approve ? "denied by user" : "no approver (use --yes or a permissive mode)";
      return { use, output: `Approval required for ${use.name}: ${why}`, isError: true };
    }
  }

  const finalInput = decision.updatedInput ?? data;
  const span = tracer.startSpan(
    "execute_tool",
    { [GEN_AI_OPERATION_NAME]: "execute_tool", [GEN_AI_TOOL_NAME]: use.name },
    parentSpan,
  );
  try {
    const result = await tool.call(finalInput, ctx);
    const raw =
      typeof result.content === "string" ? result.content : JSON.stringify(result.content);
    // Fence content from untrusted sources so the model treats it as data,
    // not instructions (ADR 0003). Dormant until a tool sets `untrusted`.
    const output = result.untrusted ? fence(raw, use.name === "bash" ? "bash" : "mcp") : raw;
    span.setStatus(result.isError ? "error" : "ok").end();
    return { use, output, isError: result.isError ?? false };
  } catch (err) {
    span.setStatus("error").end();
    return { use, output: `Tool error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function* chatWithRetry(
  config: QueryConfig,
  messages: readonly Message[],
  toolDefs: readonly ToolDefinition[],
  signal: AbortSignal,
): AsyncGenerator<QueryEvent, LLMResponse> {
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  // On a retryable failure, escalate through the fallback chain (ADR 0005)
  // rather than hammering the same (possibly overloaded) model.
  const chain = fallbackChain(config.model, config.roles ?? {}, config.role);
  let chainIdx = 0;
  for (let attempt = 1; ; attempt++) {
    const providerConfig = {
      model: chain[chainIdx] ?? config.model,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      systemPrompt: config.systemPrompt,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
    };
    try {
      return await config.provider.chat(messages, toolDefs, providerConfig, { signal });
    } catch (err) {
      if (!isRetryable(err) || attempt >= maxRetries) throw err;
      if (chainIdx + 1 < chain.length) chainIdx++;
      const delay = computeDelay(attempt, retryAfterMs(err));
      yield {
        type: "retrying",
        attempt,
        delayMs: delay,
        reason: err instanceof Error ? err.message : String(err),
      };
      await sleep(delay, signal);
    }
  }
}

function toToolResultMessage(o: ToolOutcome): Message {
  return { role: "tool_result", toolUseId: o.use.id, content: o.output, isError: o.isError };
}

export async function* runQuery(
  userMessage: string,
  config: QueryConfig,
): AsyncGenerator<QueryEvent, QueryState> {
  const tools = (config.tools ?? getAllTools()).filter((t) => t.isEnabled());
  const toolDefs = tools.map(toToolDefinition);
  const signal = config.signal ?? new AbortController().signal;
  const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxContextTokens = config.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;

  const ctx: ToolContext = {
    workingDir: config.permissions.workingDir,
    signal,
    readFileState: new Map(),
    permissions: config.permissions,
  };

  // Telemetry + cost (ADR 0004). The tracer is a no-op unless ALFRED_OTEL_FILE is set.
  const tracer = tracerFromEnv();
  const agentSpan = tracer.startSpan("invoke_agent", {
    [GEN_AI_OPERATION_NAME]: "invoke_agent",
    [GEN_AI_REQUEST_MODEL]: config.model,
  });
  let cost = new CostTracker();

  const messages: Message[] = [{ role: "user", content: userMessage }];
  let usage: Usage = ZERO_USAGE;
  let turns = 0;

  const finish = (status: TerminalStatus): QueryState => {
    agentSpan.setStatus(status === "success" ? "ok" : "error").end();
    return {
      messages: [...messages],
      turns,
      usage,
      status,
      cost: cost.total(),
    };
  };

  while (turns < maxTurns) {
    turns++;
    if (signal.aborted) return finish("aborted");

    // Compact older context at a user boundary when near the budget (ADR 0001 §7.4).
    if (shouldCompact(messages, { maxContextTokens })) {
      const compacted = await compact(messages, {
        provider: config.provider,
        model: config.model,
        maxContextTokens,
      });
      if (compacted !== messages) {
        messages.length = 0;
        messages.push(...compacted);
      }
    }

    let response: LLMResponse;
    const chatSpan = tracer.startSpan(
      "chat",
      {
        [GEN_AI_OPERATION_NAME]: "chat",
        [GEN_AI_SYSTEM]: config.provider.name,
        [GEN_AI_REQUEST_MODEL]: config.model,
      },
      agentSpan,
    );
    try {
      response = yield* chatWithRetry(config, messages, toolDefs, signal);
    } catch (err) {
      chatSpan.setStatus("error").end();
      const msg = err instanceof ProviderError ? err.message : err instanceof Error ? err.message : String(err);
      yield { type: "error", message: msg };
      return finish(signal.aborted ? "aborted" : "provider_error");
    }
    chatSpan
      .setAttribute(GEN_AI_USAGE_INPUT_TOKENS, response.usage.inputTokens)
      .setAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, response.usage.outputTokens)
      .setStatus("ok")
      .end();

    usage = addUsage(usage, response.usage);
    cost = cost.add(response.model, response.usage);
    for (const block of response.content) {
      if (block.type === "text" && block.text.length > 0) {
        yield { type: "text", text: block.text };
      }
    }

    messages.push({ role: "assistant", content: response.content });

    if (response.stopReason !== "tool_use") {
      yield { type: "done", status: "success" };
      return finish("success");
    }

    const uses: ToolUse[] = response.content
      .filter((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));

    const parallel = uses.filter((u) => isParallelizable(tools, u));
    const serial = uses.filter((u) => !isParallelizable(tools, u));

    for (const use of parallel) {
      yield { type: "tool_use", id: use.id, name: use.name, describe: describeUse(tools, use), input: use.input };
    }
    const parallelResults = await Promise.all(
      parallel.map((u) => executeTool(u, tools, ctx, tracer, agentSpan, config.approve)),
    );
    for (const outcome of parallelResults) {
      yield { type: "tool_result", id: outcome.use.id, name: outcome.use.name, output: outcome.output, isError: outcome.isError };
      messages.push(toToolResultMessage(outcome));
    }

    for (const use of serial) {
      yield { type: "tool_use", id: use.id, name: use.name, describe: describeUse(tools, use), input: use.input };
      const outcome = await executeTool(use, tools, ctx, tracer, agentSpan, config.approve);
      yield { type: "tool_result", id: outcome.use.id, name: outcome.use.name, output: outcome.output, isError: outcome.isError };
      messages.push(toToolResultMessage(outcome));
    }
  }

  yield { type: "error", message: `Reached max turns (${maxTurns})` };
  yield { type: "done", status: "max_turns" };
  return finish("max_turns");
}
