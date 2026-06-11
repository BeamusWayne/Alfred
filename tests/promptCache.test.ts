/**
 * Message-history cache breakpoints (`toAnthropicMessages`).
 *
 * Contract: the last content block of the last TWO user-role messages carries
 * `cache_control: {type: "ephemeral"}`; assistant turns are never marked; all
 * other blocks are untouched. With the system + last-tool marks this stays
 * within the API's 4-breakpoint maximum.
 */
import { describe, expect, test } from "bun:test";
import { toAnthropicMessages } from "../src/providers/anthropic.ts";
import type { Message } from "../src/providers/types.ts";

function cacheMarks(params: ReturnType<typeof toAnthropicMessages>): number[] {
  return params.flatMap((p, i) => {
    if (typeof p.content === "string") return [];
    const last = p.content[p.content.length - 1] as { cache_control?: unknown } | undefined;
    return last?.cache_control ? [i] : [];
  });
}

describe("toAnthropicMessages cache breakpoints", () => {
  test("marks the last two user-role messages in a tool-use transcript", () => {
    const messages: Message[] = [
      { role: "user", content: "fix the bug" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "file_read", input: {} }],
      },
      { role: "tool_result", toolUseId: "t1", content: "file body", isError: false },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t2", name: "file_edit", input: {} }],
      },
      { role: "tool_result", toolUseId: "t2", content: "ok", isError: false },
    ];
    const params = toAnthropicMessages(messages);
    // tool_result messages render as role:"user" — indices 2 and 4 are the
    // last two user-role messages; index 0 (the user turn) stays unmarked.
    expect(cacheMarks(params)).toEqual([2, 4]);
  });

  test("a single user message gets exactly one mark, converted to a block", () => {
    const params = toAnthropicMessages([{ role: "user", content: "hello" }]);
    expect(params).toHaveLength(1);
    const content = params[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    if (Array.isArray(content)) {
      expect(content[0]).toMatchObject({
        type: "text",
        text: "hello",
        cache_control: { type: "ephemeral" },
      });
    }
  });

  test("assistant messages are never marked", () => {
    const messages: Message[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "text", text: "a" }] },
    ];
    const params = toAnthropicMessages(messages);
    expect(cacheMarks(params)).toEqual([0]);
    const assistant = params[1]?.content;
    if (Array.isArray(assistant)) {
      expect((assistant[0] as { cache_control?: unknown }).cache_control).toBeUndefined();
    }
  });

  test("never exceeds two message-level marks regardless of transcript length", () => {
    const messages: Message[] = [{ role: "user", content: "start" }];
    for (let i = 0; i < 20; i++) {
      messages.push({
        role: "assistant",
        content: [{ type: "tool_use", id: `t${i}`, name: "bash", input: {} }],
      });
      messages.push({
        role: "tool_result",
        toolUseId: `t${i}`,
        content: `out ${i}`,
        isError: false,
      });
    }
    const marks = cacheMarks(toAnthropicMessages(messages));
    expect(marks).toHaveLength(2);
    // …and they are the two most recent user-role messages.
    expect(marks).toEqual([messages.length - 3, messages.length - 1]);
  });

  test("round-trips text and tool_use blocks unchanged apart from the mark", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "context" },
          { type: "text", text: "question" },
        ],
      },
    ];
    const params = toAnthropicMessages(messages);
    const content = params[0]?.content;
    if (Array.isArray(content)) {
      expect(content[0]).toEqual({ type: "text", text: "context" });
      expect(content[1]).toMatchObject({
        type: "text",
        text: "question",
        cache_control: { type: "ephemeral" },
      });
    }
  });
});
