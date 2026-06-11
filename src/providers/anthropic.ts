/**
 * Anthropic provider (@anthropic-ai/sdk).
 *   - prompt caching: `cache_control` on the last system block + last tool, so
 *     the stable prefix is billed at ~0.1x on cache hits;
 *   - streaming: incremental text deltas via `client.messages.stream`;
 *   - token counting: `client.messages.countTokens`;
 *   - errors mapped to ProviderError with `retryable` + `retryAfterMs`, so the
 *     loop's backoff layer can do its job.
 */
import Anthropic from "@anthropic-ai/sdk";
import { defaultMaxTokens, modelProfile } from "../config/modelCatalog.ts";
import {
  type ChatOptions,
  type ContentBlock,
  type LLMResponse,
  type Message,
  type Provider,
  type ProviderConfig,
  ProviderError,
  type StopReason,
  type StreamEvent,
  type ToolDefinition,
  type Usage,
} from "./types.ts";

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

function blockToParam(block: ContentBlock): Anthropic.ContentBlockParam {
  if (block.type === "text") return { type: "text", text: block.text };
  // Thinking blocks round-trip verbatim: the API rejects tool-loop assistant
  // turns whose thinking blocks were dropped.
  if (block.type === "thinking") {
    return { type: "thinking", thinking: block.thinking, signature: block.signature };
  }
  if (block.type === "redacted_thinking") {
    return { type: "redacted_thinking", data: block.data };
  }
  // Compaction blocks (beta) replace compacted history server-side; the GA
  // param union doesn't know them yet, hence the cast.
  if (block.type === "compaction") {
    return {
      type: "compaction",
      content: block.content,
      encrypted_content: block.encryptedContent,
    } as unknown as Anthropic.ContentBlockParam;
  }
  return { type: "tool_use", id: block.id, name: block.name, input: block.input };
}

/** Re-create `msg` with `cache_control` on its final content block. */
function markLastBlock(msg: Anthropic.MessageParam): Anthropic.MessageParam {
  const blocks: Anthropic.ContentBlockParam[] =
    typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : [...msg.content];
  const last = blocks[blocks.length - 1];
  // Thinking blocks cannot carry cache_control — they never appear in the
  // user-role messages we mark, but the type guard keeps this total.
  if (!last || last.type === "thinking" || last.type === "redacted_thinking") return msg;
  blocks[blocks.length - 1] = { ...last, cache_control: { type: "ephemeral" } };
  return { ...msg, content: blocks };
}

/**
 * Exported for tests. Converts the transcript and places cache breakpoints on
 * the last content block of the last TWO user-role messages (user turns and
 * tool results both render as `role: "user"`). Together with the breakpoints
 * on the system prompt and the last tool this uses the API maximum of 4.
 *
 * Without these, only tools+system are cached and the entire message history
 * — the bulk of a long run's input — is re-billed at full price every turn.
 * Two marks (not one) keep a hit reachable when a single turn appends more
 * blocks than the cache's 20-block lookback window.
 */
export function toAnthropicMessages(messages: readonly Message[]): Anthropic.MessageParam[] {
  const params = messages.map((m): Anthropic.MessageParam => {
    if (m.role === "user") {
      return {
        role: "user",
        content: typeof m.content === "string" ? m.content : m.content.map(blockToParam),
      };
    }
    if (m.role === "assistant") {
      return { role: "assistant", content: m.content.map(blockToParam) };
    }
    return {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: m.toolUseId, content: m.content, is_error: m.isError },
      ],
    };
  });

  const markIdx = new Set<number>();
  for (let i = params.length - 1; i >= 0 && markIdx.size < 2; i--) {
    if (params[i]?.role === "user") markIdx.add(i);
  }
  return params.map((p, i) => (markIdx.has(i) ? markLastBlock(p) : p));
}

function toAnthropicTools(tools: readonly ToolDefinition[]): Anthropic.ToolUnion[] {
  return tools.map((t, i) => {
    const tool: Anthropic.Tool = {
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    };
    // Cache the whole tool block by marking the last tool (stable prefix).
    if (i === tools.length - 1) {
      return { ...tool, cache_control: { type: "ephemeral" } };
    }
    return tool;
  });
}

function fromStopReason(reason: string | null): StopReason {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    case "refusal":
      return "refusal";
    case "pause_turn":
      return "pause_turn";
    case "model_context_window_exceeded":
      return "model_context_window_exceeded";
    case "end_turn":
      return "end_turn";
    default:
      return "unknown";
  }
}

/** A compaction block as it appears on the wire when the beta is active. */
interface WireCompactionBlock {
  readonly type: "compaction";
  readonly content: string | null;
  readonly encrypted_content: string | null;
}

/** Exported for tests: response blocks → Alfred blocks (thinking + compaction preserved). */
export function fromContent(blocks: Anthropic.ContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const b of blocks as ReadonlyArray<Anthropic.ContentBlock | WireCompactionBlock>) {
    if (b.type === "text") out.push({ type: "text", text: b.text });
    else if (b.type === "tool_use") {
      out.push({
        type: "tool_use",
        id: b.id,
        name: b.name,
        input: b.input as Record<string, unknown>,
      });
    } else if (b.type === "thinking") {
      out.push({ type: "thinking", thinking: b.thinking, signature: b.signature });
    } else if (b.type === "redacted_thinking") {
      out.push({ type: "redacted_thinking", data: b.data });
    } else if (b.type === "compaction") {
      out.push({
        type: "compaction",
        content: b.content,
        encryptedContent: b.encrypted_content,
      });
    }
  }
  return out;
}

function fromUsage(u: Anthropic.Usage): Usage {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Map any thrown error to a `ProviderError` with an accurate `retryable` flag.
 *
 * The order matters: `APIConnectionError` and `APIUserAbortError` both extend
 * `APIError`, so they are matched first.
 *
 * The key correctness rule: an `APIError` is retryable ONLY when it carries an
 * explicitly retryable HTTP status. A 4xx like an invalid model name (400) is
 * deterministic — retrying the identical request just fails identically and
 * burns the backoff budget — so it must fail fast. (The previous logic treated
 * any status-less `APIError` as retryable, which mis-retried such failures.)
 */
export function toProviderError(err: unknown): ProviderError {
  // Connection-level failures carry no HTTP status and are transient — retry.
  // APIConnectionTimeoutError extends APIConnectionError, so this covers both.
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError(err.message, { retryable: true });
  }
  // A user-initiated abort is terminal — never retry it.
  if (err instanceof Anthropic.APIUserAbortError) {
    return new ProviderError(err.message, { retryable: false });
  }
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === "number" ? err.status : undefined;
    // `err.headers` is a web `Headers` instance — must use `.get()`, not index
    // access (which silently returned undefined before, defeating Retry-After).
    const retryAfterHeader = err.headers?.get("retry-after");
    const retryAfterSec = retryAfterHeader != null ? Number(retryAfterHeader) : Number.NaN;
    const retryAfterMs = Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : undefined;
    const retryable = status !== undefined && RETRYABLE_STATUS.has(status);
    return new ProviderError(err.message, { status, retryable, retryAfterMs });
  }
  // Unknown non-SDK error: an abort is terminal; otherwise treat as a blip.
  const message = err instanceof Error ? err.message : String(err);
  const aborted = message.toLowerCase().includes("abort");
  return new ProviderError(message, { retryable: !aborted });
}

function makeClient(config: ProviderConfig): Anthropic {
  return new Anthropic({
    apiKey: config.apiKey ?? process.env.ANTHROPIC_API_KEY,
    // ALFRED_BASE_URL points the Messages API at any compatible endpoint (e.g. Zhipu GLM).
    baseURL: config.baseUrl ?? process.env.ALFRED_BASE_URL ?? process.env.ANTHROPIC_BASE_URL,
  });
}

/** The system prompt as a cache-marked block (stable prefix), or undefined. */
function systemBlocks(config: ProviderConfig): Anthropic.TextBlockParam[] | undefined {
  return config.systemPrompt
    ? [{ type: "text", text: config.systemPrompt, cache_control: { type: "ephemeral" } }]
    : undefined;
}

/** Beta header required for `output_config.task_budget`. */
const TASK_BUDGET_BETA = "task-budgets-2026-03-13";

/** Beta header required for server-side compaction. */
const COMPACTION_BETA = "compact-2026-01-12";

/** Minimum whole-task budget the API accepts. */
const MIN_TASK_BUDGET_TOKENS = 20_000;

export interface BuiltRequest {
  readonly params: Anthropic.MessageCreateParamsNonStreaming;
  /** anthropic-beta header values this request needs (empty for pure GA). */
  readonly betas: readonly string[];
}

/**
 * Build the Messages API request, applying the model's capability profile:
 *   - `max_tokens` defaults from the catalog (and is always capped by the
 *     model's output ceiling, so a fallback-chain model switch stays valid);
 *   - `temperature` is dropped on models that reject sampling params;
 *   - adaptive thinking is ON by default where supported ("none" opts out);
 *     models without adaptive support get no `thinking` field at all;
 *   - `effort` / `task_budget` are sent only where supported (task_budget
 *     additionally needs its beta header, returned in `betas`).
 *
 * Exported for tests — this is the contract that keeps any configured model
 * from receiving a parameter it would 400 on.
 */
export function buildRequest(
  messages: readonly Message[],
  tools: readonly ToolDefinition[],
  config: ProviderConfig,
  streaming: boolean,
): BuiltRequest {
  const profile = modelProfile(config.model);
  const taskBudget =
    profile.supportsTaskBudget &&
    config.taskBudgetTokens !== undefined &&
    config.taskBudgetTokens >= MIN_TASK_BUDGET_TOKENS
      ? Math.floor(config.taskBudgetTokens)
      : undefined;
  const effort = profile.supportsEffort ? config.effort : undefined;
  const format =
    profile.supportsStructuredOutput && config.responseSchema !== undefined
      ? ({
          type: "json_schema",
          schema: config.responseSchema,
        } satisfies Anthropic.JSONOutputFormat)
      : undefined;
  // task_budget is typed in the SDK's beta namespace but rides the same wire
  // field; the GA cast is confined to this one spot.
  const outputConfig =
    effort !== undefined || taskBudget !== undefined || format !== undefined
      ? ({
          ...(effort !== undefined ? { effort } : {}),
          ...(format !== undefined ? { format } : {}),
          ...(taskBudget !== undefined
            ? { task_budget: { type: "tokens", total: taskBudget } }
            : {}),
        } as Anthropic.OutputConfig)
      : undefined;

  // Server-side compaction (beta): the API summarises earlier context once
  // input exceeds the trigger. The GA param type doesn't know the field, so
  // the merged object is cast once below.
  const compaction =
    profile.supportsServerCompaction && config.serverCompaction !== undefined
      ? {
          context_management: {
            edits: [
              {
                type: "compact_20260112",
                trigger: {
                  type: "input_tokens",
                  value: Math.floor(config.serverCompaction.triggerTokens),
                },
              },
            ],
          },
        }
      : undefined;

  const params = {
    model: config.model,
    max_tokens: Math.min(
      config.maxTokens ?? defaultMaxTokens(profile, streaming),
      profile.maxOutput,
    ),
    system: systemBlocks(config),
    messages: toAnthropicMessages(messages),
    ...(tools.length > 0 ? { tools: toAnthropicTools(tools) } : {}),
    ...(profile.supportsTemperature && config.temperature !== undefined
      ? { temperature: config.temperature }
      : {}),
    ...(profile.thinking === "adaptive" && config.thinking !== "none"
      ? { thinking: { type: "adaptive" as const } }
      : {}),
    ...(outputConfig !== undefined ? { output_config: outputConfig } : {}),
    ...(compaction ?? {}),
  } as Anthropic.MessageCreateParamsNonStreaming;
  const betas = [
    ...(taskBudget !== undefined ? [TASK_BUDGET_BETA] : []),
    ...(compaction !== undefined ? [COMPACTION_BETA] : []),
  ];
  return { params, betas };
}

function requestOptions(
  betas: readonly string[],
  signal: AbortSignal | undefined,
): { signal?: AbortSignal; headers?: Record<string, string> } {
  return {
    signal,
    ...(betas.length > 0 ? { headers: { "anthropic-beta": betas.join(",") } } : {}),
  };
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";

  async chat(
    messages: readonly Message[],
    tools: readonly ToolDefinition[],
    config: ProviderConfig,
    options?: ChatOptions,
  ): Promise<LLMResponse> {
    const client = makeClient(config);
    const { params, betas } = buildRequest(messages, tools, config, false);
    try {
      const response = await client.messages.create(params, requestOptions(betas, options?.signal));
      return {
        content: fromContent(response.content),
        stopReason: fromStopReason(response.stop_reason),
        usage: fromUsage(response.usage),
        model: response.model,
      };
    } catch (err) {
      throw toProviderError(err);
    }
  }

  async *stream(
    messages: readonly Message[],
    tools: readonly ToolDefinition[],
    config: ProviderConfig,
    options?: ChatOptions,
  ): AsyncGenerator<StreamEvent, LLMResponse> {
    const client = makeClient(config);
    const { params, betas } = buildRequest(messages, tools, config, true);
    try {
      const s = client.messages.stream(params, requestOptions(betas, options?.signal));
      for await (const event of s) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { type: "text_delta", text: event.delta.text };
        }
      }
      const final = await s.finalMessage();
      return {
        content: fromContent(final.content),
        stopReason: fromStopReason(final.stop_reason),
        usage: fromUsage(final.usage),
        model: final.model,
      };
    } catch (err) {
      throw toProviderError(err);
    }
  }

  async countTokens(
    messages: readonly Message[],
    tools: readonly ToolDefinition[],
    config: ProviderConfig,
  ): Promise<number> {
    const client = makeClient(config);
    try {
      const r = await client.messages.countTokens({
        model: config.model,
        system: systemBlocks(config),
        messages: toAnthropicMessages(messages),
        tools: tools.length > 0 ? toAnthropicTools(tools) : undefined,
      });
      return r.input_tokens;
    } catch (err) {
      throw toProviderError(err);
    }
  }
}
