/**
 * Tests for the context-compaction subsystem — ADR 0001 §7.4.
 *
 * Uses MockProvider for deterministic, offline execution.
 */

import { describe, expect, test } from "bun:test";
import { compact, shouldCompact } from "../src/compact/engine.ts";
import { estimateMessages, estimateTokens } from "../src/compact/tokens.ts";
import { MockProvider, textResponse } from "../src/providers/mock.ts";
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

function toolUseMsg(id: string, name: string): Message {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input: { path: "/tmp/x" } }],
  };
}

function toolResultMsg(toolUseId: string, content: string): Message {
  return { role: "tool_result", toolUseId, content, isError: false };
}

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  test("empty string → 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("4-char string → 1", () => {
    expect(estimateTokens("abcd")).toBe(1);
  });

  test("5-char string → 2 (ceil)", () => {
    expect(estimateTokens("abcde")).toBe(2);
  });

  test("100-char string → 25", () => {
    expect(estimateTokens("a".repeat(100))).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// estimateMessages
// ---------------------------------------------------------------------------

describe("estimateMessages", () => {
  test("empty list → 0", () => {
    expect(estimateMessages([])).toBe(0);
  });

  test("single user string message", () => {
    const msgs: readonly Message[] = [userMsg("hello")]; // 5 chars → 2
    expect(estimateMessages(msgs)).toBe(2);
  });

  test("assistant message with text block", () => {
    const msgs: readonly Message[] = [assistantMsg("hi")]; // 2 chars → 1
    expect(estimateMessages(msgs)).toBe(1);
  });

  test("tool_result message", () => {
    const msgs: readonly Message[] = [toolResultMsg("id1", "ok")]; // 2 chars → 1
    expect(estimateMessages(msgs)).toBe(1);
  });

  test("mixed messages sum correctly", () => {
    const msgs: readonly Message[] = [
      userMsg("aaaa"),       // 4 → 1
      assistantMsg("bbbb"),  // 4 → 1
      toolResultMsg("x", "cccc"), // 4 → 1
    ];
    expect(estimateMessages(msgs)).toBe(3);
  });

  test("does not mutate input array", () => {
    const msgs: readonly Message[] = [userMsg("test")];
    const before = msgs.length;
    estimateMessages(msgs);
    expect(msgs.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// shouldCompact
// ---------------------------------------------------------------------------

describe("shouldCompact", () => {
  test("returns false when well below threshold", () => {
    // 4 chars = 1 token; budget 1000 * 0.8 = 800
    const msgs: readonly Message[] = [userMsg("a".repeat(4))];
    expect(shouldCompact(msgs, { maxContextTokens: 1000 })).toBe(false);
  });

  test("returns true when above default threshold (0.8)", () => {
    // 900 tokens > 1000 * 0.8 = 800
    const msgs: readonly Message[] = [userMsg("a".repeat(900 * 4))];
    expect(shouldCompact(msgs, { maxContextTokens: 1000 })).toBe(true);
  });

  test("respects custom threshold", () => {
    // 600 tokens; threshold 0.5 → budget 500 → should compact
    const msgs: readonly Message[] = [userMsg("a".repeat(600 * 4))];
    expect(shouldCompact(msgs, { maxContextTokens: 1000, threshold: 0.5 })).toBe(true);
  });

  test("returns false just under custom threshold", () => {
    // 400 tokens; threshold 0.5 → budget 500 → should NOT compact
    const msgs: readonly Message[] = [userMsg("a".repeat(400 * 4))];
    expect(shouldCompact(msgs, { maxContextTokens: 1000, threshold: 0.5 })).toBe(false);
  });

  test("exactly at threshold does not compact (> not >=)", () => {
    // exactly 800 tokens; 1000 * 0.8 = 800; 800 > 800 is false
    const msgs: readonly Message[] = [userMsg("a".repeat(800 * 4))];
    expect(shouldCompact(msgs, { maxContextTokens: 1000 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// compact — happy path
// ---------------------------------------------------------------------------

describe("compact — happy path", () => {
  test("returns shorter list starting with a summary message", async () => {
    const summaryText = "summary of earlier work";
    const provider = new MockProvider([textResponse(summaryText)]);

    // Build a message list long enough to exceed keepRecent (default 6)
    const messages: readonly Message[] = [
      userMsg("task 1"),
      assistantMsg("done 1"),
      userMsg("task 2"),
      assistantMsg("done 2"),
      userMsg("task 3"),
      assistantMsg("done 3"),
      userMsg("task 4"),      // tail starts here (keepRecent=6, split at index ~2)
      assistantMsg("done 4"),
      userMsg("task 5"),
      assistantMsg("done 5"),
    ];

    const result = await compact(messages, {
      provider,
      model: "mock",
      maxContextTokens: 100_000,
    });

    expect(result.length).toBeLessThan(messages.length);
    const first = result[0];
    expect(first?.role).toBe("user");
    if (first?.role === "user" && typeof first.content === "string") {
      expect(first.content).toContain(summaryText);
    }
  });

  test("recent tail is preserved verbatim", async () => {
    const provider = new MockProvider([textResponse("compact summary here")]);

    const messages: readonly Message[] = [
      userMsg("old 1"),
      assistantMsg("old reply 1"),
      userMsg("old 2"),
      assistantMsg("old reply 2"),
      userMsg("recent A"),   // these form the tail
      assistantMsg("recent reply A"),
      userMsg("recent B"),
      assistantMsg("recent reply B"),
    ];

    const result = await compact(messages, {
      provider,
      model: "mock",
      keepRecent: 4,
      maxContextTokens: 100_000,
    });

    // The last 4 original messages should appear at the end of result
    const tail = result.slice(-4);
    expect(tail[0]).toEqual(messages[4]);
    expect(tail[1]).toEqual(messages[5]);
    expect(tail[2]).toEqual(messages[6]);
    expect(tail[3]).toEqual(messages[7]);
  });

  test("provider is called exactly once (for summary)", async () => {
    const provider = new MockProvider([textResponse("brief summary")]);

    const messages: readonly Message[] = [
      userMsg("m1"), assistantMsg("r1"),
      userMsg("m2"), assistantMsg("r2"),
      userMsg("m3"), assistantMsg("r3"),
      userMsg("m4"), assistantMsg("r4"),
    ];

    await compact(messages, { provider, model: "mock", keepRecent: 4, maxContextTokens: 100_000 });
    expect(provider.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// compact — user-boundary invariant
// ---------------------------------------------------------------------------

describe("compact — user-boundary invariant", () => {
  test("split never orphans a tool_result from its assistant tool_use", async () => {
    const provider = new MockProvider([textResponse("summary")]);

    // Pattern: user → assistant(tool_use) → tool_result → user → assistant → ...
    const messages: readonly Message[] = [
      userMsg("start"),
      toolUseMsg("id1", "read_file"),
      toolResultMsg("id1", "file contents here"),
      userMsg("continue"),
      assistantMsg("done"),
      userMsg("next"),
      assistantMsg("ok"),
    ];

    const result = await compact(messages, {
      provider,
      model: "mock",
      keepRecent: 3,
      maxContextTokens: 100_000,
    });

    // Verify no tool_result appears as the first non-summary message
    // (i.e. the split landed on a user boundary, not inside a tool_use/result pair)
    const nonSummary = result.slice(1);
    for (let i = 0; i < nonSummary.length; i++) {
      const msg = nonSummary[i];
      if (msg?.role === "tool_result") {
        // There must be a preceding assistant message with tool_use in the same slice
        const prev = nonSummary[i - 1];
        expect(prev?.role).toBe("assistant");
      }
    }
  });

  test("result always starts with a user-role message", async () => {
    const provider = new MockProvider([textResponse("summary text")]);

    const messages: readonly Message[] = [
      userMsg("a"), assistantMsg("b"),
      userMsg("c"), assistantMsg("d"),
      userMsg("e"), assistantMsg("f"),
      userMsg("g"), assistantMsg("h"),
    ];

    const result = await compact(messages, {
      provider,
      model: "mock",
      keepRecent: 4,
      maxContextTokens: 100_000,
    });

    expect(result[0]?.role).toBe("user");
  });
});

// ---------------------------------------------------------------------------
// compact — below-threshold / too-few messages
// ---------------------------------------------------------------------------

describe("compact — no-op cases", () => {
  test("returns input unchanged when messages <= keepRecent", async () => {
    const provider = new MockProvider([textResponse("should not be called")]);

    const messages: readonly Message[] = [
      userMsg("only"), assistantMsg("two"),
    ];

    const result = await compact(messages, {
      provider,
      model: "mock",
      keepRecent: 6,
      maxContextTokens: 100_000,
    });

    expect(result).toBe(messages); // same reference — not copied
    expect(provider.calls.length).toBe(0);
  });

  test("returns input unchanged when only one safe split point exists at 0", async () => {
    const provider = new MockProvider([textResponse("no-op")]);

    // Fewer messages than keepRecent forces splitIndex=0
    const messages: readonly Message[] = [userMsg("x"), assistantMsg("y")];

    const result = await compact(messages, {
      provider,
      model: "mock",
      keepRecent: 10,
      maxContextTokens: 100_000,
    });

    expect(result).toBe(messages);
  });
});

// ---------------------------------------------------------------------------
// compact — provider error → original returned
// ---------------------------------------------------------------------------

describe("compact — provider error handling", () => {
  test("returns original messages on provider error", async () => {
    const provider = new MockProvider([new Error("network timeout")]);

    const messages: readonly Message[] = [
      userMsg("a"), assistantMsg("b"),
      userMsg("c"), assistantMsg("d"),
      userMsg("e"), assistantMsg("f"),
      userMsg("g"), assistantMsg("h"),
    ];

    const result = await compact(messages, {
      provider,
      model: "mock",
      keepRecent: 4,
      maxContextTokens: 100_000,
    });

    // Must not throw and must return original
    expect(result).toBe(messages);
  });

  test("does not throw even on unexpected provider errors", async () => {
    const provider = new MockProvider([new Error("500 Internal Server Error")]);

    const messages: readonly Message[] = [
      userMsg("1"), assistantMsg("2"),
      userMsg("3"), assistantMsg("4"),
      userMsg("5"), assistantMsg("6"),
      userMsg("7"), assistantMsg("8"),
    ];

    let threw = false;
    try {
      await compact(messages, {
        provider,
        model: "mock",
        keepRecent: 4,
        maxContextTokens: 100_000,
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// compact — tool-driven transcript (regression: previously a silent no-op)
// ---------------------------------------------------------------------------

describe("compact — tool-driven transcript", () => {
  test("compacts a single-user transcript of assistant/tool_result turns", async () => {
    const provider = new MockProvider([textResponse("the summary")]);

    // The real agent-loop shape: ONE user message, then many
    // assistant(tool_use) → tool_result turns. The old user-boundary search
    // walked back to index 0 here and made compact a no-op.
    const messages: Message[] = [userMsg("do the task")];
    for (let i = 0; i < 12; i++) {
      messages.push(toolUseMsg(`id${i}`, "read_file"));
      messages.push(toolResultMsg(`id${i}`, `result ${i}`));
    }

    const result = await compact(messages, {
      provider,
      model: "mock",
      keepRecent: 6,
      maxContextTokens: 100_000,
    });

    expect(provider.calls.length).toBe(1); // it actually summarised (not a no-op)
    expect(result.length).toBeLessThan(messages.length);
    expect(result[0]?.role).toBe("user"); // the summary message
    // The tail must begin at a turn boundary, never orphaning a tool_result.
    expect(result[1]?.role).not.toBe("tool_result");
  });
});
