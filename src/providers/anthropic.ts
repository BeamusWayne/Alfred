/**
 * Anthropic provider. Differences from the old implementation (per the review):
 *   - prompt caching: `cache_control` on the system prompt and the tool block,
 *     so the stable prefix is billed at ~0.1x on cache hits;
 *   - real usage including cache read/write tokens;
 *   - errors mapped to ProviderError with `retryable` + `retryAfterMs`, so the
 *     loop's backoff layer can do its job.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  ProviderError,
  type ChatOptions,
  type ContentBlock,
  type LLMResponse,
  type Message,
  type Provider,
  type ProviderConfig,
  type StopReason,
  type ToolDefinition,
  type Usage,
} from "./types.ts";

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

function blockToParam(block: ContentBlock): Anthropic.ContentBlockParam {
  if (block.type === "text") return { type: "text", text: block.text };
  return { type: "tool_use", id: block.id, name: block.name, input: block.input };
}

function toAnthropicMessages(messages: readonly Message[]): Anthropic.MessageParam[] {
  return messages.map((m): Anthropic.MessageParam => {
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
}

function toAnthropicTools(tools: readonly ToolDefinition[]): Anthropic.ToolUnion[] {
  return tools.map((t, i) => {
    const tool: Anthropic.Tool = {
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    };
    // Cache the whole tool block by marking the last tool.
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
    case "end_turn":
      return "end_turn";
    default:
      return "unknown";
  }
}

function fromContent(blocks: Anthropic.ContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const b of blocks) {
    if (b.type === "text") out.push({ type: "text", text: b.text });
    else if (b.type === "tool_use") {
      out.push({ type: "tool_use", id: b.id, name: b.name, input: b.input as Record<string, unknown> });
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

function toProviderError(err: unknown): ProviderError {
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    const headers = (err.headers ?? {}) as Record<string, string | undefined>;
    const retryAfterRaw = headers["retry-after"];
    const retryAfterMs = retryAfterRaw ? Number(retryAfterRaw) * 1000 : undefined;
    const retryable = status === undefined || RETRYABLE_STATUS.has(status);
    return new ProviderError(err.message, { status, retryable, retryAfterMs });
  }
  // Connection / abort errors have no status — treat as retryable network blips.
  const message = err instanceof Error ? err.message : String(err);
  const aborted = message.toLowerCase().includes("abort");
  return new ProviderError(message, { retryable: !aborted });
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";

  async chat(
    messages: readonly Message[],
    tools: readonly ToolDefinition[],
    config: ProviderConfig,
    options?: ChatOptions,
  ): Promise<LLMResponse> {
    const client = new Anthropic({
      apiKey: config.apiKey ?? process.env.ANTHROPIC_API_KEY,
      baseURL: config.baseUrl ?? process.env.ANTHROPIC_BASE_URL,
    });

    const system: Anthropic.TextBlockParam[] | undefined = config.systemPrompt
      ? [{ type: "text", text: config.systemPrompt, cache_control: { type: "ephemeral" } }]
      : undefined;

    try {
      const response = await client.messages.create(
        {
          model: config.model,
          max_tokens: config.maxTokens ?? 8192,
          temperature: config.temperature,
          system,
          messages: toAnthropicMessages(messages),
          tools: tools.length > 0 ? toAnthropicTools(tools) : undefined,
        },
        { signal: options?.signal },
      );
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
}
