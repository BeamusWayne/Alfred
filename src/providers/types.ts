/**
 * Provider abstraction — the seam between Alfred and any LLM backend.
 *
 * Everything here is plain data (immutable by convention): construct new
 * objects, never mutate. A `Provider` turns a list of `Message`s + tool
 * definitions into an `LLMResponse`.
 */

export interface TextBlock {
  readonly type: "text";
  readonly text: string;
}

export interface ToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

/**
 * A reasoning block (Anthropic adaptive/extended thinking). Carried opaquely:
 * Alfred never interprets it, but MUST round-trip it back to the provider in
 * multi-turn tool loops — the API rejects assistant turns whose thinking
 * blocks were dropped. Non-Anthropic providers skip these when serialising.
 */
export interface ThinkingBlock {
  readonly type: "thinking";
  readonly thinking: string;
  readonly signature: string;
}

/** A redacted reasoning block — fully opaque, round-tripped via `data`. */
export interface RedactedThinkingBlock {
  readonly type: "redacted_thinking";
  readonly data: string;
}

/** Assistant-authored content. */
export type ContentBlock = TextBlock | ToolUseBlock | ThinkingBlock | RedactedThinkingBlock;

export interface UserMessage {
  readonly role: "user";
  readonly content: string | readonly ContentBlock[];
}

export interface AssistantMessage {
  readonly role: "assistant";
  readonly content: readonly ContentBlock[];
}

/** A tool result is sent back to the model as a distinct turn. */
export interface ToolResultMessage {
  readonly role: "tool_result";
  readonly toolUseId: string;
  readonly content: string;
  readonly isError: boolean;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/**
 * Why the model stopped. `tool_use` means it wants tools run and the loop
 * should continue. `max_tokens` is a truncation, `pause_turn` a resumable
 * server-side pause, and `model_context_window_exceeded` an input overflow —
 * none of these are a natural end of turn and the loop must handle them.
 */
export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "refusal"
  | "pause_turn"
  | "model_context_window_exceeded"
  | "unknown";

export interface LLMResponse {
  readonly content: readonly ContentBlock[];
  readonly stopReason: StopReason;
  readonly usage: Usage;
  readonly model: string;
}

/** A tool as the model sees it: name, description, JSON-schema input. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** Reasoning-depth knob (`output_config.effort`) on models that support it. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ProviderConfig {
  readonly model: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly systemPrompt?: string;
  readonly maxTokens?: number;
  /** Only sent to models that accept sampling params (gated by the catalog). */
  readonly temperature?: number;
  /**
   * Thinking mode. Defaults to "adaptive" on models that support it; pass
   * "none" to suppress. Ignored on models without adaptive thinking.
   */
  readonly thinking?: "adaptive" | "none";
  /** Reasoning effort; only sent to models with effort support. */
  readonly effort?: Effort;
  /**
   * Whole-task token budget surfaced to the model (`output_config.task_budget`,
   * beta). Only sent on supporting models and when ≥ the API minimum (20k).
   */
  readonly taskBudgetTokens?: number;
  /**
   * JSON schema the response text must conform to (native structured outputs).
   * Providers map it to their own knob (Anthropic `output_config.format`,
   * OpenAI `response_format`, Gemini `responseSchema`) and silently ignore it
   * on models without support — callers keep a parse-and-validate fallback.
   */
  readonly responseSchema?: Record<string, unknown>;
}

export interface ChatOptions {
  /** Abort in-flight requests (Esc / cancellation). */
  readonly signal?: AbortSignal;
}

/**
 * An error a provider can raise. `retryable` lets the agent loop's retry
 * layer decide whether a backoff retry is worthwhile; `retryAfterMs` carries
 * a server `Retry-After` when present.
 */
export class ProviderError extends Error {
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    opts: { status?: number; retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** A streaming delta — incremental text as the model produces it. */
export interface TextDeltaEvent {
  readonly type: "text_delta";
  readonly text: string;
}
export type StreamEvent = TextDeltaEvent;

export interface Provider {
  readonly name: string;
  chat(
    messages: readonly Message[],
    tools: readonly ToolDefinition[],
    config: ProviderConfig,
    options?: ChatOptions,
  ): Promise<LLMResponse>;
  /** Optional token-streaming chat: yields text deltas, returns the final response. */
  stream?(
    messages: readonly Message[],
    tools: readonly ToolDefinition[],
    config: ProviderConfig,
    options?: ChatOptions,
  ): AsyncGenerator<StreamEvent, LLMResponse>;
  /** Optional accurate prompt token count (e.g. Anthropic count_tokens). */
  countTokens?(
    messages: readonly Message[],
    tools: readonly ToolDefinition[],
    config: ProviderConfig,
  ): Promise<number>;
}
