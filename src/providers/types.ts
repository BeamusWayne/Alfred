import { z } from "zod";

// --- Message types (unified across providers) ---

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessage {
  role: "user";
  content: string | ContentBlock[];
}

export interface AssistantMessage {
  role: "assistant";
  content: ContentBlock[];
}

export interface ToolResultMessage {
  role: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

export type ContentBlock =
  | TextBlock
  | ToolUseBlock;

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// --- Tool definition ---

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType<unknown>;
}

// --- Provider interface ---

export interface StreamEvent {
  type: "text_delta" | "tool_use_start" | "tool_use_delta" | "message_stop" | "error";
  text?: string;
  toolUseId?: string;
  toolName?: string;
  toolInputDelta?: string;
  error?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface LLMResponse {
  content: ContentBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  usage: Usage;
  model: string;
}

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
}

export interface Provider {
  readonly name: string;

  chat(
    messages: Message[],
    tools: ToolDefinition[],
    config: ProviderConfig,
  ): Promise<LLMResponse>;

  stream(
    messages: Message[],
    tools: ToolDefinition[],
    config: ProviderConfig,
  ): AsyncGenerator<StreamEvent, LLMResponse>;

  countTokens(text: string): Promise<number>;
}
