/**
 * OpenAI provider — implements the neutral `Provider` interface against the
 * OpenAI Chat Completions HTTP API (/v1/chat/completions).
 *
 * ADR 0005 (second provider for routing + fallback): adding a credible second
 * backend enables cross-provider fallback and best-of-N routing in the engine's
 * retry/fallback chain without changing any tool or loop code above this layer.
 *
 * Uses the global `fetch` (Bun runtime) — no `openai` npm package required.
 */

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

// ---------------------------------------------------------------------------
// Internal OpenAI wire types (unknown at HTTP boundary, narrowed below)
// ---------------------------------------------------------------------------

interface OpenAIFunction {
  readonly name: string;
  readonly arguments: string;
}

interface OpenAIToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: OpenAIFunction;
}

interface OpenAIAssistantMessage {
  readonly role: "assistant";
  readonly content: string | null;
  readonly tool_calls?: readonly OpenAIToolCall[];
}

interface OpenAIUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly prompt_tokens_details?: { readonly cached_tokens?: number };
}

interface OpenAIChoice {
  readonly message: OpenAIAssistantMessage;
  readonly finish_reason: string;
}

interface OpenAIResponse {
  readonly id: string;
  readonly model: string;
  readonly choices: readonly OpenAIChoice[];
  readonly usage: OpenAIUsage;
}

interface OpenAIErrorBody {
  readonly error?: { readonly message?: string };
}

// ---------------------------------------------------------------------------
// Outbound wire types (request body)
// ---------------------------------------------------------------------------

type OpenAIRequestMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string | null;
      readonly tool_calls?: readonly OpenAIToolCall[];
    }
  | { readonly role: "tool"; readonly tool_call_id: string; readonly content: string };

interface OpenAITool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

interface OpenAIRequestBody {
  readonly model: string;
  readonly messages: readonly OpenAIRequestMessage[];
  readonly tools?: readonly OpenAITool[];
  readonly max_tokens?: number;
  readonly temperature?: number;
}

// ---------------------------------------------------------------------------
// Status codes that warrant a retry
// ---------------------------------------------------------------------------

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);

// ---------------------------------------------------------------------------
// Mapping helpers: Alfred → OpenAI
// ---------------------------------------------------------------------------

function toOpenAIMessages(
  messages: readonly Message[],
  systemPrompt: string | undefined,
): readonly OpenAIRequestMessage[] {
  const out: OpenAIRequestMessage[] = [];

  if (systemPrompt) {
    out.push({ role: "system", content: systemPrompt });
  }

  for (const m of messages) {
    if (m.role === "tool_result") {
      out.push({
        role: "tool",
        tool_call_id: m.toolUseId,
        content: m.content,
      });
      continue;
    }

    if (m.role === "user") {
      const content =
        typeof m.content === "string"
          ? m.content
          : m.content
              .filter((b) => b.type === "text")
              .map((b) => (b as { type: "text"; text: string }).text)
              .join("\n");
      out.push({ role: "user", content });
      continue;
    }

    // assistant message — may have text and/or tool_use blocks
    const toolCalls: OpenAIToolCall[] = [];
    let textContent: string | null = null;

    for (const block of m.content) {
      if (block.type === "text") {
        textContent = block.text;
      } else {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      }
    }

    out.push({
      role: "assistant",
      content: textContent,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }

  return out;
}

function toOpenAITools(tools: readonly ToolDefinition[]): readonly OpenAITool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

// ---------------------------------------------------------------------------
// Mapping helpers: OpenAI → Alfred
// ---------------------------------------------------------------------------

function fromFinishReason(reason: string): StopReason {
  switch (reason) {
    case "tool_calls":
      return "tool_use";
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "unknown";
  }
}

function parseToolInput(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function fromOpenAIMessage(msg: OpenAIAssistantMessage): readonly ContentBlock[] {
  const blocks: ContentBlock[] = [];

  if (msg.content) {
    blocks.push({ type: "text", text: msg.content });
  }

  for (const tc of msg.tool_calls ?? []) {
    blocks.push({
      type: "tool_use",
      id: tc.id,
      name: tc.function.name,
      input: parseToolInput(tc.function.arguments),
    });
  }

  return blocks;
}

function fromOpenAIUsage(u: OpenAIUsage): Usage {
  return {
    inputTokens: u.prompt_tokens,
    outputTokens: u.completion_tokens,
    cacheReadTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: 0,
  };
}

// ---------------------------------------------------------------------------
// Error extraction
// ---------------------------------------------------------------------------

async function parseRetryAfterMs(response: Response): Promise<number | undefined> {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

async function toProviderError(response: Response): Promise<ProviderError> {
  const status = response.status;
  const retryable = RETRYABLE_STATUS.has(status);
  const retryAfterMs = await parseRetryAfterMs(response);

  let message = `OpenAI API error: HTTP ${status}`;
  try {
    const body: unknown = await response.json();
    if (
      body !== null &&
      typeof body === "object" &&
      "error" in body
    ) {
      const errBody = body as OpenAIErrorBody;
      if (errBody.error?.message) {
        message = errBody.error.message;
      }
    }
  } catch {
    // response body not JSON — keep generic message
  }

  return new ProviderError(message, { status, retryable, retryAfterMs });
}

// ---------------------------------------------------------------------------
// Narrow the raw JSON response at the HTTP boundary
// ---------------------------------------------------------------------------

function isValidOpenAIResponse(raw: unknown): raw is OpenAIResponse {
  if (raw === null || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r["id"] === "string" &&
    typeof r["model"] === "string" &&
    Array.isArray(r["choices"]) &&
    r["choices"].length > 0 &&
    r["usage"] !== undefined
  );
}

// ---------------------------------------------------------------------------
// Fetcher type (injectable for tests)
// ---------------------------------------------------------------------------

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export class OpenAIProvider implements Provider {
  readonly name = "openai";

  readonly #fetcher: Fetcher;
  readonly #baseUrl: string;

  constructor(fetcher: Fetcher = fetch, baseUrl = "https://api.openai.com/v1") {
    this.#fetcher = fetcher;
    this.#baseUrl = baseUrl;
  }

  async chat(
    messages: readonly Message[],
    tools: readonly ToolDefinition[],
    config: ProviderConfig,
    options?: ChatOptions,
  ): Promise<LLMResponse> {
    const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new ProviderError("OPENAI_API_KEY is not configured", { retryable: false });
    }

    const body: OpenAIRequestBody = {
      model: config.model,
      messages: toOpenAIMessages(messages, config.systemPrompt),
      ...(tools.length > 0 ? { tools: toOpenAITools(tools) } : {}),
      ...(config.maxTokens !== undefined ? { max_tokens: config.maxTokens } : {}),
      ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    };

    const response = await this.#fetcher(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!response.ok) {
      throw await toProviderError(response);
    }

    const raw: unknown = await response.json();

    if (!isValidOpenAIResponse(raw)) {
      throw new ProviderError("Unexpected OpenAI response shape", { retryable: false });
    }

    const choice = raw.choices[0];
    if (choice === undefined) {
      throw new ProviderError("OpenAI response had no choices", { retryable: false });
    }

    return {
      content: fromOpenAIMessage(choice.message),
      stopReason: fromFinishReason(choice.finish_reason),
      usage: fromOpenAIUsage(raw.usage),
      model: raw.model,
    };
  }
}
