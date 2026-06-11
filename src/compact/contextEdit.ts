/**
 * Context editing — ADR 0001 §4 / §7.4 (context editing — distinct from compaction).
 *
 * Compaction summarises the older portion of a conversation into a single
 * synthetic message. Context editing does something cheaper and structurally
 * non-destructive: it PRUNES the bulky `content` of OLD `tool_result` messages,
 * replacing it with a short placeholder string.  The conversation skeleton (and
 * all recent tool results) is kept intact, yielding the −84%-tokens reduction
 * referenced in ADR 0001 §4.
 *
 * Call order in the query loop:
 *   1. editContext  — evict stale tool results (this module)
 *   2. compact      — summarise if still over budget (engine.ts)
 */

import type { Message, ToolResultMessage } from "../providers/types.ts";
import { estimateMessages } from "./tokens.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options controlling when and how context editing runs. */
export interface ContextEditOptions {
  /** Hard token ceiling for the context window. */
  readonly maxContextTokens: number;
  /**
   * Fraction of `maxContextTokens` at which editing is triggered.
   * Defaults to 0.8 (80 %).
   */
  readonly threshold?: number;
  /**
   * Number of most-recent messages treated as the "protected window".
   * `tool_result` messages inside this window are never evicted.
   * Defaults to 6.
   */
  readonly keepRecent?: number;
  /**
   * Text to substitute for evicted tool-result content.
   * Defaults to `"[tool result evicted to save context]"`.
   */
  readonly placeholder?: string;
  /**
   * The real input-token count from the provider (e.g. `usage.inputTokens`
   * from the last response, or a `count_tokens` result). When > 0 this is used
   * instead of the char/4 estimate so that editing triggers on true token size.
   */
  readonly actualTokens?: number;
}

/** Return value of `editContext`. */
export interface ContextEditResult {
  /** The (possibly pruned) message array — always a new array when evictions > 0. */
  readonly messages: readonly Message[];
  /** Number of `tool_result` messages whose content was replaced. */
  readonly evicted: number;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLD = 0.8;
const DEFAULT_KEEP_RECENT = 6;
const DEFAULT_PLACEHOLDER = "[tool result evicted to save context]";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute how many tokens the conversation currently occupies. */
function currentTokens(messages: readonly Message[], opts: ContextEditOptions): number {
  if (opts.actualTokens !== undefined && opts.actualTokens > 0) {
    return opts.actualTokens;
  }
  return estimateMessages(messages);
}

/** True when the token count exceeds the trigger threshold. */
function isOverThreshold(messages: readonly Message[], opts: ContextEditOptions): boolean {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const budget = Math.floor(opts.maxContextTokens * threshold);
  return currentTokens(messages, opts) > budget;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the context exceeds `threshold × maxContextTokens`,
 * indicating that `editContext` would attempt pruning.
 *
 * Prefers `actualTokens` (when > 0) over the char/4 estimate.
 */
export function shouldEdit(messages: readonly Message[], opts: ContextEditOptions): boolean {
  return isOverThreshold(messages, opts);
}

/**
 * Prune stale `tool_result` content to free token budget.
 *
 * When the message list exceeds the threshold, every `tool_result` message
 * that falls **outside** the most-recent `keepRecent` messages has its
 * `content` replaced with `placeholder` — unless it already equals the
 * placeholder (idempotency).  All `user` and `assistant` messages are left
 * entirely untouched.
 *
 * Returns a NEW message array + `evicted` count.  If the list is under
 * threshold, or there is nothing to prune, the **original** array reference
 * is returned with `evicted: 0` (no allocation).
 */
export function editContext(
  messages: readonly Message[],
  opts: ContextEditOptions,
): ContextEditResult {
  // Fast-path: under threshold — nothing to do.
  if (!isOverThreshold(messages, opts)) {
    return { messages, evicted: 0 };
  }

  const keepRecent = opts.keepRecent ?? DEFAULT_KEEP_RECENT;
  const placeholder = opts.placeholder ?? DEFAULT_PLACEHOLDER;

  // The protected window is the last `keepRecent` messages (by index).
  const protectedStart = Math.max(0, messages.length - keepRecent);

  let evicted = 0;
  const next: Message[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    // Safety: noUncheckedIndexedAccess means msg could be undefined; guard it.
    if (msg === undefined) continue;

    const inProtectedWindow = i >= protectedStart;

    if (msg.role === "tool_result" && !inProtectedWindow && msg.content !== placeholder) {
      // Build a new ToolResultMessage with the placeholder content.
      const pruned: ToolResultMessage = {
        role: "tool_result",
        toolUseId: msg.toolUseId,
        content: placeholder,
        isError: msg.isError,
      };
      next.push(pruned);
      evicted++;
    } else {
      next.push(msg);
    }
  }

  // If nothing was actually replaced, return original reference.
  if (evicted === 0) {
    return { messages, evicted: 0 };
  }

  return { messages: next, evicted };
}
