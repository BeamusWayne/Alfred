/**
 * Session-lifecycle hook firing — ADR 0001 §7.5.
 *
 * The CLI surfaces (one-shot, REPL, `alfred run`) call these around a session
 * so external recorders see the same event stream Claude Code emits:
 * SessionStart → UserPromptSubmit → (PreToolUse/PostToolUse from the engine)
 * → Stop → SessionEnd. Only UserPromptSubmit may block (exit 2); everything
 * else is observe-only and never fails the run.
 */

import { runHooks } from "./engine.ts";
import type { HookContext, HookEvent, HooksConfig } from "./types.ts";

/** Observe-only lifecycle events a CLI surface fires around a session. */
export type LifecycleEvent = Extract<HookEvent, "SessionStart" | "Stop" | "SessionEnd">;

/**
 * Fire an observe-only lifecycle event. Best-effort by contract: a crashing
 * or blocking hook must never take the session down with it.
 */
export async function fireLifecycleHooks(
  hooks: HooksConfig,
  event: LifecycleEvent,
  context: HookContext,
  source?: string,
): Promise<void> {
  try {
    await runHooks(hooks, event, source !== undefined ? { source } : {}, {
      cwd: context.cwd,
      context,
    });
  } catch {
    // observe-only: hook failures are invisible to the run
  }
}

export interface PromptHookOutcome {
  readonly block: boolean;
  readonly reason?: string;
}

/**
 * Fire UserPromptSubmit. A hook exiting 2 blocks the prompt — the caller
 * shows `reason` and skips the query (same contract as Claude Code).
 */
export async function firePromptHooks(
  hooks: HooksConfig,
  prompt: string,
  context: HookContext,
): Promise<PromptHookOutcome> {
  try {
    const outcome = await runHooks(
      hooks,
      "UserPromptSubmit",
      { prompt },
      { cwd: context.cwd, context },
    );
    return outcome.block
      ? { block: true, reason: outcome.reason ?? "blocked by UserPromptSubmit hook" }
      : { block: false };
  } catch {
    return { block: false };
  }
}
