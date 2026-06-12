/**
 * Hook stdin payload builder — ADR 0001 §7.5.
 *
 * One place decides what a hook process sees on stdin. The shape is Claude
 * Code-compatible (`session_id`, `hook_event_name`, `tool_name`, `tool_input`,
 * `tool_response`, `prompt`, `source`, `cwd`, `model`) so recorders and policy
 * hooks built for that ecosystem — NightWatch is the motivating case — work
 * against Alfred without an adapter. Alfred's original `toolName` / `input`
 * keys are kept alongside so pre-0.7 user hooks keep parsing.
 */

import type { HookContext, HookEvent } from "./types.ts";

/** Event-specific fields a call site supplies when firing hooks. */
export interface HookFireInput {
  /** Tool events (PreToolUse / PostToolUse). */
  readonly toolName?: string;
  readonly input?: Record<string, unknown>;
  /** PostToolUse: the tool output exactly as the model will see it. */
  readonly toolResponse?: string;
  /** UserPromptSubmit: the prompt text. */
  readonly prompt?: string;
  /** SessionStart: "startup" | "repl" | "run"; SessionEnd: exit reason. */
  readonly source?: string;
}

let processSessionId: string | undefined;

/**
 * Stable fallback session id for call sites that predate explicit session
 * threading (one id per process — still stitches a run into one ledger).
 */
export function defaultSessionId(): string {
  processSessionId ??= `alfred-${crypto.randomUUID()}`;
  return processSessionId;
}

/** Build the JSON-stringified stdin payload for one hook invocation. */
export function buildHookPayload(
  event: HookEvent,
  fire: HookFireInput,
  context?: Partial<HookContext>,
): string {
  const payload: Record<string, unknown> = {
    session_id: context?.sessionId ?? defaultSessionId(),
    cwd: context?.cwd ?? process.cwd(),
    hook_event_name: event,
  };
  if (context?.model !== undefined) payload["model"] = context.model;
  if (fire.toolName !== undefined) {
    payload["tool_name"] = fire.toolName;
    payload["toolName"] = fire.toolName; // legacy key (pre-0.7 hooks)
  }
  if (fire.input !== undefined) {
    payload["tool_input"] = fire.input;
    payload["input"] = fire.input; // legacy key (pre-0.7 hooks)
  }
  if (fire.toolResponse !== undefined) payload["tool_response"] = fire.toolResponse;
  if (fire.prompt !== undefined) payload["prompt"] = fire.prompt;
  if (fire.source !== undefined) payload["source"] = fire.source;
  return JSON.stringify(payload);
}
