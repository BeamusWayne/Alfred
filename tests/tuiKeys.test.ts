/**
 * KeyDecoder tests — the three hard cases the module exists for: UTF-8
 * split across chunks (CJK), escape sequences split across chunks, and
 * bracketed paste arriving as one event.
 */
import { describe, expect, test } from "bun:test";
import { type Key, KeyDecoder } from "../src/cli/tui/keys.ts";

function collect(): { keys: Key[]; decoder: KeyDecoder; flush: () => void } {
  const keys: Key[] = [];
  let held: (() => void) | null = null;
  const decoder = new KeyDecoder((k) => keys.push(k), {
    set: (fn) => {
      held = fn;
      return fn;
    },
    clear: () => {
      held = null;
    },
  });
  return { keys, decoder, flush: () => held?.() };
}

describe("KeyDecoder", () => {
  test("plain characters and enter", () => {
    const { keys, decoder } = collect();
    decoder.feed(Buffer.from("hi\r"));
    expect(keys).toEqual([
      { type: "char", char: "h" },
      { type: "char", char: "i" },
      { type: "enter" },
    ]);
  });

  test("CJK split across chunk boundaries reassembles", () => {
    const { keys, decoder } = collect();
    const bytes = Buffer.from("你好", "utf-8"); // 6 bytes
    decoder.feed(bytes.subarray(0, 2)); // mid-codepoint
    decoder.feed(bytes.subarray(2));
    expect(keys).toEqual([
      { type: "char", char: "你" },
      { type: "char", char: "好" },
    ]);
  });

  test("arrow keys decode, even split across chunks", () => {
    const { keys, decoder } = collect();
    decoder.feed(Buffer.from("\x1b[A"));
    decoder.feed(Buffer.from("\x1b"));
    decoder.feed(Buffer.from("[B"));
    expect(keys).toEqual([{ type: "up" }, { type: "down" }]);
  });

  test("a lone ESC is held, then emitted as escape", () => {
    const { keys, decoder, flush } = collect();
    decoder.feed(Buffer.from("\x1b"));
    expect(keys).toEqual([]); // held
    flush();
    expect(keys).toEqual([{ type: "escape" }]);
  });

  test("bracketed paste is one event; inner newlines preserved", () => {
    const { keys, decoder } = collect();
    decoder.feed(Buffer.from("\x1b[200~line1\nline2\x1b[201~x"));
    expect(keys).toEqual([
      { type: "paste", text: "line1\nline2" },
      { type: "char", char: "x" },
    ]);
  });

  test("paste split across chunks still buffers as one event", () => {
    const { keys, decoder } = collect();
    decoder.feed(Buffer.from("\x1b[200~hel"));
    decoder.feed(Buffer.from("lo\x1b[2"));
    decoder.feed(Buffer.from("01~"));
    expect(keys).toEqual([{ type: "paste", text: "hello" }]);
  });

  test("control keys map", () => {
    const { keys, decoder } = collect();
    decoder.feed(Buffer.from("\x03\x04\x0c\x15\x0b\x17\x01\x05\x7f\x0a\x09"));
    expect(keys.map((k) => k.type)).toEqual([
      "ctrl-c",
      "ctrl-d",
      "ctrl-l",
      "ctrl-u",
      "ctrl-k",
      "ctrl-w",
      "ctrl-a",
      "ctrl-e",
      "backspace",
      "newline",
      "tab",
    ]);
  });

  test("home/end/delete CSI variants", () => {
    const { keys, decoder } = collect();
    decoder.feed(Buffer.from("\x1b[H\x1b[F\x1b[3~\x1b[1~\x1b[4~\x1b[Z"));
    expect(keys.map((k) => k.type)).toEqual(["home", "end", "delete", "home", "end", "shift-tab"]);
  });

  test("alt+enter inserts a newline", () => {
    const { keys, decoder } = collect();
    decoder.feed(Buffer.from("\x1b\r"));
    expect(keys).toEqual([{ type: "newline" }]);
  });
});
