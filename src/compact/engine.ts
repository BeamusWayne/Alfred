/**
 * Context compaction engine — ADR 0001 §7.4.
 *
 * When the running transcript approaches the token budget, `compact` summarises
 * the OLDER portion into a single synthetic user message and keeps the recent
 * tail verbatim.  The split point is always at a **user-message boundary** so
 * that a tool_use / tool_result pair is never severed.
 *
 * Compaction is best-effort: if the provider call fails, the original message
 * list is returned unchanged so the outer loop is never crashed.
 */

import type { Message, Provider, UserMessage } from "../providers/types.ts";
import { estimateMessages, estimateTokens } from "./tokens.ts";

/** Options for `shouldCompact`. */
export interface ShouldCompactOptions {
  /** Hard token ceiling for the context window. */
  readonly maxContextTokens: number;
  /**
   * Fraction of `maxContextTokens` at which compaction is triggered.
   * Defaults to 0.8 (80 %).
   */
  readonly threshold?: number;
}

/** Options for `compact`. */
export interface CompactOptions {
  /** Provider used to produce the summary. */
  readonly provider: Provider;
  /** Model identifier passed to the provider. */
  readonly model: string;
  /**
   * Approximate number of recent messages to keep verbatim.
   * Defaults to 6.
   */
  readonly keepRecent?: number;
  /** Hard token ceiling — used to choose the split fraction. */
  readonly maxContextTokens: number;
}

const DEFAULT_THRESHOLD = 0.8;
const DEFAULT_KEEP_RECENT = 6;

/**
 * Returns `true` when the estimated token count of `messages` exceeds
 * `threshold × maxContextTokens`.
 */
export function shouldCompact(
  messages: readonly Message[],
  opts: ShouldCompactOptions,
): boolean {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const budget = Math.floor(opts.maxContextTokens * threshold);
  return estimateMessages(messages) > budget;
}

/**
 * Find the latest index (exclusive) such that messages[splitIndex] is a `user`
 * message and the tail `messages[splitIndex..]` contains approximately
 * `keepRecent` messages — but never split a tool_result away from its
 * preceding assistant turn.
 *
 * Returns 0 when no safe split is found (i.e. compact would be a no-op).
 */
function findSplitIndex(messages: readonly Message[], keepRecent: number): number {
  if (messages.length <= keepRecent) return 0;

  // Start scanning from the position that would give us `keepRecent` tail msgs.
  let candidate = messages.length - keepRecent;

  // Walk backwards until we land on a `user` role boundary.
  while (candidate > 0 && messages[candidate]?.role !== "user") {
    candidate--;
  }

  // Ensure the candidate isn't a tool_result (shouldn't be at a user boundary,
  // but be defensive: tool_result has role "tool_result" not "user").
  // Also ensure we're not splitting after index 0 with nothing to summarise.
  if (candidate <= 0) return 0;

  return candidate;
}

const SUMMARISATION_SYSTEM = `You are a context-compaction assistant for an autonomous coding agent called Alfred.
Your sole job is to produce a concise, information-dense summary of the conversation excerpt provided.
The summary MUST capture:
- Every decision made and its rationale
- All file paths read, written, or discussed
- Any open threads, TODOs, or unresolved questions
- Tool calls that succeeded or failed and why
- Any errors, blockers, or constraints discovered
Write in past tense, third-person. Output plain prose — no markdown headers. Be complete but not verbose.`;

const SUMMARISATION_PROMPT_PREFIX = `Summarise the following conversation excerpt from an autonomous coding session. Capture all decisions, file paths, open threads, errors, and outcomes so the conversation can be resumed without reading the original.\n\n---\n\n`;

/** Serialise a slice of messages into a human-readable excerpt for the LLM. */
function renderExcerpt(messages: readonly Message[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .map((b) => (b.type === "text" ? b.text : `[tool_use: ${b.name}]`))
              .join(" ");
      parts.push(`USER: ${text}`);
    } else if (msg.role === "assistant") {
      const text = msg.content
        .map((b) => (b.type === "text" ? b.text : `[tool_use: ${b.name}(${JSON.stringify(b.input)})]`))
        .join(" ");
      parts.push(`ASSISTANT: ${text}`);
    } else {
      const prefix = msg.isError ? "TOOL_ERROR" : "TOOL_RESULT";
      parts.push(`${prefix}(${msg.toolUseId}): ${msg.content}`);
    }
  }
  return parts.join("\n");
}

/**
 * Compact the message list by summarising the older portion.
 *
 * Returns a NEW array: `[summaryUserMessage, ...recentTail]`.
 * If there is nothing meaningful to compact, or if the provider call fails,
 * returns the original `messages` array unchanged (best-effort).
 */
export async function compact(
  messages: readonly Message[],
  opts: CompactOptions,
): Promise<readonly Message[]> {
  const keepRecent = opts.keepRecent ?? DEFAULT_KEEP_RECENT;
  const splitIndex = findSplitIndex(messages, keepRecent);

  // Nothing to compact.
  if (splitIndex <= 0) return messages;

  const toSummarise = messages.slice(0, splitIndex);
  const recentTail = messages.slice(splitIndex);

  const excerpt = renderExcerpt(toSummarise);
  const prompt = `${SUMMARISATION_PROMPT_PREFIX}${excerpt}`;

  const summaryRequest: readonly Message[] = [{ role: "user", content: prompt }];

  let summaryText: string;
  try {
    const response = await opts.provider.chat(summaryRequest, [], {
      model: opts.model,
      systemPrompt: SUMMARISATION_SYSTEM,
      maxTokens: Math.min(2048, Math.floor(opts.maxContextTokens * 0.15)),
    });

    const textBlock = response.content.find((b) => b.type === "text");
    summaryText = textBlock?.text ?? "(summary unavailable)";
  } catch {
    // Compaction is best-effort — never crash the loop.
    return messages;
  }

  const summaryMessage: UserMessage = {
    role: "user",
    content: `[Context summary — earlier conversation compacted]\n\n${summaryText}`,
  };

  return [summaryMessage, ...recentTail];
}
