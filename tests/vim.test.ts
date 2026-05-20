import { describe, test, expect, beforeEach } from "bun:test";
import { createVimEditor, type VimEditor, type VimMode } from "../src/vim/editor.js";

describe("vim editor", () => {
  let editor: VimEditor;

  beforeEach(() => {
    editor = createVimEditor();
  });

  test("starts in INSERT mode", () => {
    expect(editor.getMode()).toBe("INSERT");
  });

  test("ESC switches to NORMAL mode", () => {
    editor.processInput("h", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    expect(editor.getValue()).toBe("h");
    editor.processInput("", { escape: true, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    expect(editor.getMode()).toBe("NORMAL");
  });

  test("i switches from NORMAL to INSERT mode", () => {
    editor.processInput("", { escape: true, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    expect(editor.getMode()).toBe("NORMAL");
    editor.processInput("i", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    expect(editor.getMode()).toBe("INSERT");
  });

  test("typing in INSERT mode appends characters", () => {
    editor.processInput("a", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    editor.processInput("b", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    editor.processInput("c", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    expect(editor.getValue()).toBe("abc");
  });

  test("hjkl do not type in NORMAL mode", () => {
    editor.processInput("", { escape: true, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    editor.processInput("h", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    editor.processInput("j", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    editor.processInput("k", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    editor.processInput("l", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    expect(editor.getValue()).toBe("");
  });

  test("l moves cursor right in NORMAL mode", () => {
    editor.processInput("a", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    editor.processInput("b", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    editor.processInput("c", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    editor.processInput("", { escape: true, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    expect(editor.getCursor()).toBe(2); // ESC moves cursor left

    editor.processInput("l", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    expect(editor.getCursor()).toBe(3);
  });

  test("h moves cursor left in NORMAL mode", () => {
    editor.processInput("a", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    editor.processInput("b", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    editor.processInput("", { escape: true, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    expect(editor.getCursor()).toBe(1);

    editor.processInput("h", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    expect(editor.getCursor()).toBe(0);
  });

  test("h does not go below 0", () => {
    editor.processInput("a", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    editor.processInput("", { escape: true, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    editor.processInput("h", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    editor.processInput("h", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    editor.processInput("h", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    expect(editor.getCursor()).toBe(0);
  });

  test("dd deletes entire line in NORMAL mode", () => {
    editor.processInput("a", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    editor.processInput("b", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    editor.processInput("c", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    editor.processInput("", { escape: true, return: false, backspace: false, delete: false, ctrl: false, meta: false });

    // Type 'd' then 'd' for dd
    editor.processInput("d", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    editor.processInput("d", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    expect(editor.getValue()).toBe("");
  });

  test("x deletes character under cursor in NORMAL mode", () => {
    editor.processInput("a", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    editor.processInput("b", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    editor.processInput("c", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    editor.processInput("", { escape: true, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    // ESC moves cursor left: cursor at 2 (pointing to 'c')
    // x deletes char at cursor position → deletes 'c'
    editor.processInput("x", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    expect(editor.getValue()).toBe("ab");

    // Move to start and delete 'a'
    editor.processInput("0", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    editor.processInput("x", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    expect(editor.getValue()).toBe("b");
  });

  test("backspace works in INSERT mode", () => {
    editor.processInput("a", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    editor.processInput("b", { escape: false, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    editor.processInput("", { escape: false, return: false, backspace: true, delete: false, ctrl: false, meta: false });
    expect(editor.getValue()).toBe("a");
  });

  test("setValue replaces content", () => {
    editor.setValue("hello world");
    expect(editor.getValue()).toBe("hello world");
    expect(editor.getCursor()).toBe(11);
  });

  test("mode indicator", () => {
    expect(editor.getMode()).toBe("INSERT");
    editor.processInput("", { escape: true, return: false, backspace: false, delete: false, ctrl: false, meta: false });
    expect(editor.getMode()).toBe("NORMAL");
  });
});
