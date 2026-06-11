import type { Effort, Message, Provider, Usage } from "../providers/types.ts";
import type { ToolPermissionContext } from "../permissions/types.ts";
import type { Tool } from "../tools/types.ts";
import type { Role, RoleModelMap } from "../config/roles.ts";
import type { HooksConfig } from "../hooks/types.ts";
import type { MemoryProvider } from "../memory/types.ts";

/**
 * How the loop ended — typed so a caller (REPL, headless runner, harness) can
 * tell "resume me" from "fatal" (the review flagged the old loop's single
 * overloaded error type as a real gap).
 */
export type TerminalStatus = "success" | "max_turns" | "provider_error" | "truncated" | "aborted";

export interface ApprovalRequest {
  readonly toolName: string;
  readonly description: string;
  readonly reason?: string;
  readonly input: Record<string, unknown>;
}

export interface QueryConfig {
  readonly provider: Provider;
  readonly model: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly systemPrompt?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** "none" opts out of adaptive thinking on models that support it. */
  readonly thinking?: "adaptive" | "none";
  /** Reasoning effort; defaults per role on supporting models (ADR 0005). */
  readonly effort?: Effort;
  /** Whole-task token budget surfaced to the model (beta; supporting models only). */
  readonly taskBudgetTokens?: number;
  /** Native structured-output schema (supporting models; callers keep a fallback). */
  readonly responseSchema?: Record<string, unknown>;
  /** Sub-agent nesting depth (internal); spawn_subagent is removed at depth ≥ 1. */
  readonly subagentDepth?: number;
  readonly maxTurns?: number;
  readonly permissions: ToolPermissionContext;
  /** Defaults to the built-in tool set. */
  readonly tools?: readonly Tool[];
  /** Called when a tool needs approval ("ask"). Returns true to proceed. */
  readonly approve?: (req: ApprovalRequest) => Promise<boolean>;
  readonly signal?: AbortSignal;
  readonly maxRetries?: number;
  /** Context-window ceiling that triggers compaction (ADR 0001 §7.4). */
  readonly maxContextTokens?: number;
  /** Role→model map for retry fallback escalation (ADR 0005). */
  readonly roles?: RoleModelMap;
  /** Active role; selects the head of the fallback chain (ADR 0005). */
  readonly role?: Role;
  /** PreToolUse/PostToolUse hooks fired around each tool call (ADR 0001 §7.5). */
  readonly hooks?: HooksConfig;
  /** When present, the engine prefetches relevant facts before turn 1 (ADR 0001 §4). */
  readonly memory?: MemoryProvider;
}

export type QueryEvent =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly describe: string;
      readonly input: Record<string, unknown>;
    }
  | {
      readonly type: "tool_result";
      readonly id: string;
      readonly name: string;
      readonly output: string;
      readonly isError: boolean;
    }
  | {
      readonly type: "retrying";
      readonly attempt: number;
      readonly delayMs: number;
      readonly reason: string;
      /** Model that failed; equal to `toModel` when no fallback advance happened. */
      readonly fromModel: string;
      /** Model the next attempt will use — makes fallback downgrades observable. */
      readonly toModel: string;
    }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "done"; readonly status: TerminalStatus };

export interface QueryState {
  readonly messages: readonly Message[];
  readonly turns: number;
  readonly usage: Usage;
  readonly status: TerminalStatus;
  /** Accumulated token cost for the run (ADR 0004); present once the loop runs. */
  readonly cost?: { readonly usd: number; readonly usage: Usage };
}
