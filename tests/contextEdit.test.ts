/**
 * Tests for the context-editing subsystem — ADR 0001 §4 / §7.4
 * (context editing — distinct from compaction).
 *
 * Verifies:
 *  - Old tool_result bodies are replaced with the placeholder.
 *  - Recent tool_results (inside keepRecent window) are untouched.
 *  - User and assistant messages are never touched.
 *  - `evicted` count is accurate.
 *  - Under-threshold inputs are a no-op (same reference returned).
 *  - Operation is idempotent (second pass evicts 0 more).
 *  - `actualTokens` override drives the threshold check.
 */

import { describe, expect, test } from "bun:test";
import { editContext, shouldEdit } from "../src/compact/contextEdit.ts";
import type { Message } from "../src/providers/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userMsg(content: string): Message {
  return { role: "user", content };
}

function assistantMsg(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function toolResultMsg(toolUseId: string, content: string, isError = false): Message {
  return { role: "tool_result", toolUseId, content, isError };
}

/** Build a list large enough to exceed the default 0.8 threshold for a given maxContextTokens. */
function bigToolResult(chars: number): Message {
  return toolResultMsg("id-big", "x".repeat(chars));
}

// ---------------------------------------------------------------------------
// shouldEdit
// ---------------------------------------------------------------------------

describe("shouldEdit", () => {
  test("returns false when well under threshold", () => {
    // 4 chars = 1 token; budget = 1000 * 0.8 = 800
    const msgs: readonly Message[] = [userMsg("a".repeat(4))];
    expect(shouldEdit(msgs, { maxContextTokens: 1000 })).toBe(false);
  });

  test("returns true when above default threshold", () => {
    // 900 tokens > 800 budget
    const msgs: readonly Message[] = [userMsg("a".repeat(900 * 4))];
    expect(shouldEdit(msgs, { maxContextTokens: 1000 })).toBe(true);
  });

  test("respects custom threshold", () => {
    // 600 tokens; threshold 0.5 → budget 500 → should edit
    const msgs: readonly Message[] = [userMsg("a".repeat(600 * 4))];
    expect(shouldEdit(msgs, { maxContextTokens: 1000, threshold: 0.5 })).toBe(true);
  });

  test("returns false just under custom threshold", () => {
    // 400 tokens; threshold 0.5 → budget 500 → should NOT edit
    const msgs: readonly Message[] = [userMsg("a".repeat(400 * 4))];
    expect(shouldEdit(msgs, { maxContextTokens: 1000, threshold: 0.5 })).toBe(false);
  });

  test("exactly at threshold does not trigger (> not >=)", () => {
    // exactly 800 tokens; 1000 * 0.8 = 800; 800 > 800 is false
    const msgs: readonly Message[] = [userMsg("a".repeat(800 * 4))];
    expect(shouldEdit(msgs, { maxContextTokens: 1000 })).toBe(false);
  });

  test("actualTokens override drives the check — over budget", () => {
    // char estimate is tiny but actualTokens says we're over
    const msgs: readonly Message[] = [userMsg("small")];
    expect(shouldEdit(msgs, { maxContextTokens: 1000, actualTokens: 900 })).toBe(true);
  });

  test("actualTokens override drives the check — under budget", () => {
    // char estimate would be large, but actualTokens says we're under
    const msgs: readonly Message[] = [userMsg("a".repeat(900 * 4))];
    expect(shouldEdit(msgs, { maxContextTokens: 1000, actualTokens: 100 })).toBe(false);
  });

  test("actualTokens = 0 falls back to estimation", () => {
    // actualTokens = 0 → use estimate; 900 tokens > budget
    const msgs: readonly Message[] = [userMsg("a".repeat(900 * 4))];
    expect(shouldEdit(msgs, { maxContextTokens: 1000, actualTokens: 0 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// editContext — under-threshold no-op
// ---------------------------------------------------------------------------

describe("editContext — under threshold", () => {
  test("returns original array reference when under threshold", () => {
    const msgs: readonly Message[] = [
      userMsg("small message"),
      toolResultMsg("id1", "tiny result"),
    ];
    const result = editContext(msgs, { maxContextTokens: 1_000_000 });
    expect(result.messages).toBe(msgs); // same reference — no allocation
    expect(result.evicted).toBe(0);
  });

  test("evicted is 0 when under threshold even with old tool_results", () => {
    const msgs: readonly Message[] = [
      toolResultMsg("id1", "old result"),
      userMsg("recent"),
    ];
    const result = editContext(msgs, { maxContextTokens: 1_000_000 });
    expect(result.evicted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// editContext — basic eviction
// ---------------------------------------------------------------------------

describe("editContext — eviction of old tool_results", () => {
  test("replaces content of old tool_result messages with placeholder", () => {
    // Create a list over threshold: lots of content in old tool results
    const oldResult1 = toolResultMsg("id1", "a".repeat(4000)); // ~1000 tokens
    const oldResult2 = toolResultMsg("id2", "b".repeat(4000)); // ~1000 tokens
    const msgs: readonly Message[] = [
      userMsg("task"),
      oldResult1,
      oldResult2,
      userMsg("r1"),
      assistantMsg("r2"),
      userMsg("r3"),
      assistantMsg("r4"),
    ];
    // keepRecent = 3 → protected window = last 3 messages
    const result = editContext(msgs, {
      maxContextTokens: 1000,
      keepRecent: 3,
    });

    // Both old tool results should be replaced
    expect(result.evicted).toBe(2);

    const m1 = result.messages[1];
    const m2 = result.messages[2];
    expect(m1?.role).toBe("tool_result");
    if (m1?.role === "tool_result") {
      expect(m1.content).toBe("[tool result evicted to save context]");
    }
    expect(m2?.role).toBe("tool_result");
    if (m2?.role === "tool_result") {
      expect(m2.content).toBe("[tool result evicted to save context]");
    }
  });

  test("preserves toolUseId and isError on evicted messages", () => {
    const msgs: readonly Message[] = [
      toolResultMsg("use-abc", "big content " + "x".repeat(4000), true),
      userMsg("r1"),
      assistantMsg("r2"),
      userMsg("r3"),
      assistantMsg("r4"),
      userMsg("r5"),
      assistantMsg("r6"),
    ];
    const result = editContext(msgs, { maxContextTokens: 1000, keepRecent: 6 });
    expect(result.evicted).toBe(1);

    const evictedMsg = result.messages[0];
    expect(evictedMsg?.role).toBe("tool_result");
    if (evictedMsg?.role === "tool_result") {
      expect(evictedMsg.toolUseId).toBe("use-abc");
      expect(evictedMsg.isError).toBe(true);
    }
  });

  test("uses custom placeholder when provided", () => {
    const msgs: readonly Message[] = [
      toolResultMsg("id1", "x".repeat(4000)),
      userMsg("r1"),
      assistantMsg("r2"),
      userMsg("r3"),
      assistantMsg("r4"),
      userMsg("r5"),
      assistantMsg("r6"),
    ];
    const result = editContext(msgs, {
      maxContextTokens: 1000,
      keepRecent: 6,
      placeholder: "[PRUNED]",
    });
    expect(result.evicted).toBe(1);
    const evicted = result.messages[0];
    if (evicted?.role === "tool_result") {
      expect(evicted.content).toBe("[PRUNED]");
    }
  });
});

// ---------------------------------------------------------------------------
// editContext — recent window protection
// ---------------------------------------------------------------------------

describe("editContext — recent window protection", () => {
  test("tool_results inside keepRecent window are NOT evicted", () => {
    const recentResult = toolResultMsg("id-recent", "x".repeat(4000));
    const msgs: readonly Message[] = [
      toolResultMsg("id-old", "y".repeat(4000)), // outside window → evicted
      userMsg("u1"),
      assistantMsg("a1"),
      userMsg("u2"),
      assistantMsg("a2"),
      recentResult,                              // inside window (last 3)
    ];
    // keepRecent = 3 → protected = indices 3, 4, 5
    const result = editContext(msgs, { maxContextTokens: 1000, keepRecent: 3 });
    expect(result.evicted).toBe(1); // only the old one

    // Verify recentResult is untouched
    const lastMsg = result.messages[result.messages.length - 1];
    if (lastMsg?.role === "tool_result") {
      expect(lastMsg.content).toBe("x".repeat(4000));
    }
  });

  test("keepRecent = 0 exposes entire history to eviction", () => {
    const msgs: readonly Message[] = [
      toolResultMsg("id1", "x".repeat(4000)),
      toolResultMsg("id2", "y".repeat(4000)),
    ];
    const result = editContext(msgs, { maxContextTokens: 1000, keepRecent: 0 });
    expect(result.evicted).toBe(2);
  });

  test("keepRecent larger than list protects all messages", () => {
    const msgs: readonly Message[] = [
      toolResultMsg("id1", "x".repeat(4000)),
      toolResultMsg("id2", "y".repeat(4000)),
    ];
    const result = editContext(msgs, { maxContextTokens: 1000, keepRecent: 100 });
    // All messages fall inside the window — nothing evicted
    expect(result.evicted).toBe(0);
    expect(result.messages).toBe(msgs);
  });
});

// ---------------------------------------------------------------------------
// editContext — user / assistant messages untouched
// ---------------------------------------------------------------------------

describe("editContext — user and assistant messages never touched", () => {
  test("user messages are never modified", () => {
    const userContent = "user content " + "u".repeat(4000);
    const msgs: readonly Message[] = [
      userMsg(userContent),
      toolResultMsg("id1", "x".repeat(4000)),
      userMsg("r1"),
      assistantMsg("r2"),
      userMsg("r3"),
      assistantMsg("r4"),
      userMsg("r5"),
    ];
    const result = editContext(msgs, { maxContextTokens: 1000, keepRecent: 3 });

    const firstMsg = result.messages[0];
    expect(firstMsg?.role).toBe("user");
    if (firstMsg?.role === "user") {
      expect(firstMsg.content).toBe(userContent);
    }
  });

  test("assistant messages are never modified", () => {
    const assistantContent = "a".repeat(4000);
    const msgs: readonly Message[] = [
      assistantMsg(assistantContent),
      toolResultMsg("id1", "x".repeat(4000)),
      userMsg("r1"),
      assistantMsg("r2"),
      userMsg("r3"),
      assistantMsg("r4"),
      userMsg("r5"),
    ];
    const result = editContext(msgs, { maxContextTokens: 1000, keepRecent: 3 });

    const firstMsg = result.messages[0];
    expect(firstMsg?.role).toBe("assistant");
    if (firstMsg?.role === "assistant") {
      const block = firstMsg.content[0];
      if (block?.type === "text") {
        expect(block.text).toBe(assistantContent);
      }
    }
  });

  test("message count is preserved after eviction", () => {
    const msgs: readonly Message[] = [
      toolResultMsg("id1", "x".repeat(4000)),
      toolResultMsg("id2", "y".repeat(4000)),
      userMsg("r1"),
      assistantMsg("r2"),
      userMsg("r3"),
      assistantMsg("r4"),
      userMsg("r5"),
    ];
    const result = editContext(msgs, { maxContextTokens: 1000, keepRecent: 3 });
    // Evictions replace content, not remove messages
    expect(result.messages.length).toBe(msgs.length);
  });
});

// ---------------------------------------------------------------------------
// editContext — evicted count
// ---------------------------------------------------------------------------

describe("editContext — evicted count", () => {
  test("evicted counts each unique tool_result replaced", () => {
    const msgs: readonly Message[] = [
      toolResultMsg("id1", "x".repeat(4000)),
      toolResultMsg("id2", "y".repeat(4000)),
      toolResultMsg("id3", "z".repeat(4000)),
      userMsg("r1"),
      assistantMsg("r2"),
      userMsg("r3"),
    ];
    // keepRecent = 3 → protected = last 3 → indices 3, 4, 5
    const result = editContext(msgs, { maxContextTokens: 1000, keepRecent: 3 });
    expect(result.evicted).toBe(3);
  });

  test("evicted = 0 when nothing qualifies", () => {
    const msgs: readonly Message[] = [
      userMsg("u1"),
      assistantMsg("a1"),
      userMsg("u2"),
    ];
    // No tool_results at all
    const msgs2: readonly Message[] = [
      ...msgs,
      toolResultMsg("id-ok", "x".repeat(4000)), // inside recent window
    ];
    const result = editContext(msgs2, { maxContextTokens: 1000, keepRecent: 4 });
    expect(result.evicted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// editContext — idempotency
// ---------------------------------------------------------------------------

describe("editContext — idempotency", () => {
  test("running editContext twice evicts 0 the second time", () => {
    const msgs: readonly Message[] = [
      toolResultMsg("id1", "x".repeat(4000)),
      toolResultMsg("id2", "y".repeat(4000)),
      userMsg("r1"),
      assistantMsg("r2"),
      userMsg("r3"),
      assistantMsg("r4"),
      userMsg("r5"),
    ];
    const first = editContext(msgs, { maxContextTokens: 1000, keepRecent: 3 });
    expect(first.evicted).toBe(2);

    // Re-run on the pruned output; it is still over threshold (original
    // large user messages are still there) but nothing new to evict.
    // Use actualTokens to force threshold trigger, proving placeholder check.
    const second = editContext(first.messages, {
      maxContextTokens: 1000,
      keepRecent: 3,
      actualTokens: 900, // force over-threshold
    });
    expect(second.evicted).toBe(0);
  });

  test("already-placeholder content is never double-counted", () => {
    const placeholder = "[tool result evicted to save context]";
    const msgs: readonly Message[] = [
      toolResultMsg("id1", placeholder),
      toolResultMsg("id2", "x".repeat(4000)),
      userMsg("r1"),
      assistantMsg("r2"),
      userMsg("r3"),
      assistantMsg("r4"),
      userMsg("r5"),
    ];
    const result = editContext(msgs, { maxContextTokens: 1000, keepRecent: 3 });
    // id1 already has placeholder → only id2 evicted
    expect(result.evicted).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// editContext — actualTokens override
// ---------------------------------------------------------------------------

describe("editContext — actualTokens override", () => {
  test("actualTokens > 0 and over threshold triggers eviction", () => {
    // Char estimate of these messages is tiny, but actualTokens forces trigger
    const msgs: readonly Message[] = [
      toolResultMsg("id1", "small content"),
      userMsg("r1"),
      assistantMsg("r2"),
      userMsg("r3"),
      assistantMsg("r4"),
      userMsg("r5"),
      assistantMsg("r6"),
    ];
    const result = editContext(msgs, {
      maxContextTokens: 1000,
      keepRecent: 6,
      actualTokens: 900, // well over 0.8 × 1000 = 800
    });
    expect(result.evicted).toBe(1);
  });

  test("actualTokens under threshold prevents eviction", () => {
    // Char estimate would be huge, but actualTokens says we're fine
    const msgs: readonly Message[] = [
      toolResultMsg("id1", "x".repeat(40_000)),
      userMsg("r1"),
      assistantMsg("r2"),
      userMsg("r3"),
    ];
    const result = editContext(msgs, {
      maxContextTokens: 1_000_000,
      keepRecent: 3,
      actualTokens: 100, // well under budget
    });
    expect(result.evicted).toBe(0);
    expect(result.messages).toBe(msgs);
  });

  test("actualTokens = 0 falls back to char estimate", () => {
    // With actualTokens = 0, char estimate of big content triggers eviction
    const msgs: readonly Message[] = [
      toolResultMsg("id1", "x".repeat(4000)),
      userMsg("r1"),
      assistantMsg("r2"),
      userMsg("r3"),
      assistantMsg("r4"),
      userMsg("r5"),
      assistantMsg("r6"),
    ];
    const result = editContext(msgs, {
      maxContextTokens: 1000,
      keepRecent: 6,
      actualTokens: 0,
    });
    expect(result.evicted).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// editContext — immutability
// ---------------------------------------------------------------------------

describe("editContext — immutability", () => {
  test("input array is never mutated", () => {
    const msgs: readonly Message[] = [
      toolResultMsg("id1", "x".repeat(4000)),
      userMsg("r1"),
      assistantMsg("r2"),
      userMsg("r3"),
      assistantMsg("r4"),
      userMsg("r5"),
      assistantMsg("r6"),
    ];
    const originalLength = msgs.length;
    const originalContent =
      msgs[0]?.role === "tool_result" ? msgs[0].content : "";

    editContext(msgs, { maxContextTokens: 1000, keepRecent: 6 });

    expect(msgs.length).toBe(originalLength);
    if (msgs[0]?.role === "tool_result") {
      expect(msgs[0].content).toBe(originalContent);
    }
  });

  test("returned array is a new reference when evictions occurred", () => {
    const msgs: readonly Message[] = [
      toolResultMsg("id1", "x".repeat(4000)),
      userMsg("r1"),
      assistantMsg("r2"),
      userMsg("r3"),
      assistantMsg("r4"),
      userMsg("r5"),
      assistantMsg("r6"),
    ];
    const result = editContext(msgs, { maxContextTokens: 1000, keepRecent: 6 });
    expect(result.evicted).toBeGreaterThan(0);
    expect(result.messages).not.toBe(msgs);
  });
});
