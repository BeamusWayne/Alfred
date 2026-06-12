/**
 * Hooks type contracts — ADR 0001 §7.5 (hooks, exit-2-blocks)
 *
 * Defines the event taxonomy, matcher configuration, Zod validation schema,
 * and outcome type for the hooks engine. Hook payloads are JSON on stdin in a
 * Claude Code-compatible shape (snake_case `session_id` / `hook_event_name` /
 * `tool_name` / `tool_input` / `tool_response`, plus Alfred's original
 * `toolName` / `input` keys for back-compat), so recorders and policy hooks
 * written for that ecosystem — e.g. NightWatch — run against Alfred unchanged.
 * Exit 2 blocks (PreToolUse / UserPromptSubmit only); stdout
 * `{"updatedInput":{…}}` rewrites the tool input.
 */

import { z } from "zod";

/** The lifecycle events at which hooks may fire (Claude Code-compatible set). */
export type HookEvent =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "SessionEnd";

/** Events whose exit-2 blocks the action; the rest are observe-only. */
export const BLOCKING_EVENTS: ReadonlySet<HookEvent> = new Set([
  "PreToolUse",
  "UserPromptSubmit",
]);

/**
 * Per-session identity threaded into every hook payload. `sessionId` lets an
 * external recorder stitch one run's events into one ledger; `model` and
 * `cwd` give policy hooks the context Claude Code hooks expect.
 */
export interface HookContext {
  readonly sessionId: string;
  readonly cwd: string;
  readonly model?: string;
}

/**
 * A single hook entry from the user's configuration.
 *
 * `toolPattern` supports a minimal glob:
 *   - `"*"` (or omitted) — matches every tool name.
 *   - Any other string — exact match against the tool name.
 */
export interface HookMatcher {
  readonly event: HookEvent;
  /** Glob/exact tool name filter. Omit or `"*"` to match all tools. */
  readonly toolPattern?: string;
  /** Shell command executed via `sh -c`. Receives JSON payload on stdin. */
  readonly command: string;
  /** Milliseconds before the hook process is killed. Default: 10 000. */
  readonly timeoutMs?: number;
}

/** Top-level structure of `.alfred/hooks.json`. */
export interface HooksConfig {
  readonly hooks: readonly HookMatcher[];
}

/**
 * The result produced by the hooks engine after running all matching hooks
 * for a given event + tool call.
 */
export interface HookOutcome {
  /** True only when a PreToolUse hook exits 2 — the tool must NOT run. */
  readonly block: boolean;
  /** Human-readable block reason sourced from the blocking hook's stderr. */
  readonly reason?: string;
  /** Merged input rewrite from hook stdout `{"updatedInput":{…}}`. */
  readonly updatedInput?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Zod schema — used by `loadHooksConfig` to validate the JSON file.
// ---------------------------------------------------------------------------

const hookEventSchema = z.union([
  z.literal("SessionStart"),
  z.literal("UserPromptSubmit"),
  z.literal("PreToolUse"),
  z.literal("PostToolUse"),
  z.literal("Stop"),
  z.literal("SessionEnd"),
]);

const hookMatcherSchema = z.object({
  event: hookEventSchema,
  toolPattern: z.string().optional(),
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
});

export const hooksConfigSchema = z.object({
  hooks: z.array(hookMatcherSchema),
});
