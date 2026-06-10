/**
 * Token estimation utilities for context-budget decisions.
 *
 * ADR 0001 §7.4 — Compaction subsystem.
 *
 * These are intentionally coarse (1 token ≈ 4 UTF-16 code units), matching
 * the heuristic used by Anthropic's own tooling. They are pure functions with
 * no side effects and never mutate their inputs.
 */

import type { ContentBlock, Message } from "../providers/types.ts";

/**
 * Estimate the token count for a raw string.
 * Uses the standard 4-chars-per-token approximation.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate the total token count across a message list.
 *
 * Handles the `string | readonly ContentBlock[]` union on user messages and
 * the `string` content on tool_result messages.
 */
function estimateBlock(block: ContentBlock): number {
  switch (block.type) {
    case "text":
      return estimateTokens(block.text);
    case "tool_use":
      // count name + serialised input
      return estimateTokens(block.name) + estimateTokens(JSON.stringify(block.input));
    case "thinking":
      return estimateTokens(block.thinking);
    case "redacted_thinking":
      return estimateTokens(block.data);
  }
}

export function estimateMessages(messages: readonly Message[]): number {
  let total = 0;
  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        total += estimateTokens(msg.content);
      } else {
        for (const block of msg.content) total += estimateBlock(block);
      }
    } else if (msg.role === "assistant") {
      for (const block of msg.content) total += estimateBlock(block);
    } else {
      // tool_result
      total += estimateTokens(msg.content);
    }
  }
  return total;
}
