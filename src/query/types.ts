import type { Message, ContentBlock, StreamEvent, ToolDefinition } from "../providers/types.js";
import type { Tool, ToolUseContext, ToolPermissionContext } from "../tools/types.js";

export interface QueryEvent {
  type: "text" | "tool_use" | "tool_result" | "error" | "done";
  text?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  error?: string;
}

export interface QueryConfig {
  provider: string;
  model: string;
  maxTurns: number;
  systemPrompt?: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface QueryState {
  messages: Message[];
  turnCount: number;
  totalUsage: {
    inputTokens: number;
    outputTokens: number;
  };
}
