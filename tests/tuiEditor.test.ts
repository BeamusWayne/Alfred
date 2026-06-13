/**
 * Editor reducer tests — insertion, deletion, movement, the multi-line
 * contract (\⏎ newline, enter submits), and history/exit effects.
 */
import { describe, expect, test } from "bun:test";
import { applyKey, EMPTY_EDITOR, type EditorState, fromText } from "../src/cli/tui/editor.ts";
import type { Key } from "../src/cli/tui/keys.ts";

function type(state: EditorState, text: string): EditorState {
  let s = state;
  for (const ch of text) s = applyKey(s, { type: "char", char: ch }).state;
  return s;
}

const key = (type: Key["type"]): Key => ({ type }) as Key;

describe("editor", () => {
  test("typing inserts at the cursor", () => {
    const s = type(EMPTY_EDITOR, "hello");
    expect(s).toEqual({ text: "hello", cursor: 5 });
  });

  test("enter submits trimmed text and resets", () => {
    const step = applyKey(type(EMPTY_EDITOR, "  hi  "), key("enter"));
    expect(step.effect).toEqual({ kind: "submit", text: "hi" });
    expect(step.state).toEqual(EMPTY_EDITOR);
  });

  test("enter on empty input is a no-op", () => {
    expect(applyKey(EMPTY_EDITOR, key("enter")).effect).toBeUndefined();
  });

  test("backslash + enter becomes a newline (CC parity)", () => {
    const step = applyKey(type(EMPTY_EDITOR, "line1\\"), key("enter"));
    expect(step.effect).toBeUndefined();
    expect(step.state.text).toBe("line1\n");
  });

  test("paste normalises CRLF and inserts without submitting", () => {
    const step = applyKey(EMPTY_EDITOR, { type: "paste", text: "a\r\nb\rc" });
    expect(step.state.text).toBe("a\nb\nc");
    expect(step.effect).toBeUndefined();
  });

  test("backspace and delete respect surrogate pairs", () => {
    const emoji = fromText("a🤖");
    expect(applyKey(emoji, key("backspace")).state.text).toBe("a");
    const atStart: EditorState = { text: "🤖b", cursor: 0 };
    expect(applyKey(atStart, key("delete")).state.text).toBe("b");
  });

  test("home/end and ctrl-a/e operate on the current line", () => {
    const s: EditorState = { text: "one\ntwo", cursor: 6 }; // inside "two"
    expect(applyKey(s, key("home")).state.cursor).toBe(4);
    expect(applyKey(s, key("end")).state.cursor).toBe(7);
    expect(applyKey(s, key("ctrl-a")).state.cursor).toBe(4);
    expect(applyKey(s, key("ctrl-e")).state.cursor).toBe(7);
  });

  test("ctrl-k kills to end of line, ctrl-u to start, ctrl-w one word", () => {
    const s: EditorState = { text: "alpha beta", cursor: 10 };
    expect(applyKey(s, key("ctrl-w")).state.text).toBe("alpha ");
    expect(applyKey({ text: "alpha beta", cursor: 5 }, key("ctrl-k")).state.text).toBe("alpha");
    expect(applyKey({ text: "alpha beta", cursor: 5 }, key("ctrl-u")).state.text).toBe(" beta");
  });

  test("up on the first line asks for history; down on the last asks forward", () => {
    expect(applyKey(fromText("abc"), key("up")).effect).toEqual({ kind: "history-up" });
    expect(applyKey(fromText("abc"), key("down")).effect).toEqual({ kind: "history-down" });
  });

  test("up/down inside a multi-line draft moves between lines, keeping column", () => {
    const s: EditorState = { text: "long line\nxy", cursor: 12 }; // end of "xy" (col 2)
    const up = applyKey(s, key("up"));
    expect(up.effect).toBeUndefined();
    expect(up.state.cursor).toBe(2); // col 2 of line 0
    const down = applyKey(up.state, key("down"));
    expect(down.state.cursor).toBe(12);
  });

  test("escape clears and reports; ctrl-d exits only when empty", () => {
    const esc = applyKey(fromText("draft"), key("escape"));
    expect(esc.state).toEqual(EMPTY_EDITOR);
    expect(esc.effect).toEqual({ kind: "escape" });
    expect(applyKey(EMPTY_EDITOR, key("ctrl-d")).effect).toEqual({ kind: "exit" });
    expect(applyKey(fromText("x"), key("ctrl-d")).effect).toBeUndefined();
  });
});
