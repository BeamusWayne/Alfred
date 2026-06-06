/**
 * Token estimation utilities for context-budget decisions.
 *
 * ADR 0001 §7.4 — Compaction subsystem.
 *
 * These are intentionally coarse (1 token ≈ 4 UTF-16 code units), matching
 * the heuristic used by Anthropic's own tooling. They are pure functions with
 * no side effects and never mutate their inputs.
 */

import type { Message } from "../providers/types.ts";

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
export function estimateMessages(messages: readonly Message[]): number {
  let total = 0;
  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        total += estimateTokens(msg.content);
      } else {
        for (const block of msg.content) {
          if (block.type === "text") {
            total += estimateTokens(block.text);
          } else {
            // tool_use blocks: count name + serialised input
            total += estimateTokens(block.name);
            total += estimateTokens(JSON.stringify(block.input));
          }
        }
      }
    } else if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "text") {
          total += estimateTokens(block.text);
        } else {
          total += estimateTokens(block.name);
          total += estimateTokens(JSON.stringify(block.input));
        }
      }
    } else {
      // tool_result
      total += estimateTokens(msg.content);
    }
  }
  return total;
}
