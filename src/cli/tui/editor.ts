/**
 * Pure line-editor state machine for the TUI input box. Text is one string
 * with an absolute cursor offset; rendering (wrapping, the box) lives in
 * render.ts. Every transition returns a NEW state (never mutates) plus an
 * optional effect the controller acts on (submit, history nav, exit…).
 *
 * Multi-line contract (Claude Code parity): Enter submits; a trailing `\`
 * before the cursor turns Enter into a newline; ctrl-j / alt+enter always
 * insert a newline; pasted text inserts newlines verbatim.
 */

import type { Key } from "./keys.ts";

export interface EditorState {
  readonly text: string;
  readonly cursor: number; // 0..text.length, in code units
}

export type EditorEffect =
  | { readonly kind: "submit"; readonly text: string }
  | { readonly kind: "history-up" }
  | { readonly kind: "history-down" }
  | { readonly kind: "escape" } // esc on non-empty input clears; controller decides on empty
  | { readonly kind: "exit" } // ctrl-d on empty input
  | { readonly kind: "interrupt" } // ctrl-c
  | { readonly kind: "redraw" }; // ctrl-l

export interface EditorStep {
  readonly state: EditorState;
  readonly effect?: EditorEffect;
}

export const EMPTY_EDITOR: EditorState = { text: "", cursor: 0 };

export function fromText(text: string): EditorState {
  return { text, cursor: text.length };
}

/** Line index + column (code units) of the cursor — drives up/down keys. */
export function cursorLine(state: EditorState): { line: number; lines: number } {
  const before = state.text.slice(0, state.cursor);
  return {
    line: before.split("\n").length - 1,
    lines: state.text.split("\n").length,
  };
}

function insert(state: EditorState, what: string): EditorState {
  return {
    text: state.text.slice(0, state.cursor) + what + state.text.slice(state.cursor),
    cursor: state.cursor + what.length,
  };
}

/** Step one cursor position left/right, treating surrogate pairs as one. */
function step(text: string, cursor: number, dir: -1 | 1): number {
  if (dir === -1) {
    if (cursor === 0) return 0;
    const prev = text.codePointAt(cursor - 2);
    return prev !== undefined && prev > 0xffff ? cursor - 2 : cursor - 1;
  }
  if (cursor >= text.length) return text.length;
  const at = text.codePointAt(cursor);
  return at !== undefined && at > 0xffff ? cursor + 2 : cursor + 1;
}

function deleteRange(state: EditorState, from: number, to: number): EditorState {
  return { text: state.text.slice(0, from) + state.text.slice(to), cursor: from };
}

/** Start offset of the word before the cursor (ctrl-w). */
function wordStart(text: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && /\s/.test(text[i - 1] ?? "")) i--;
  while (i > 0 && !/\s/.test(text[i - 1] ?? "")) i--;
  return i;
}

function lineBounds(text: string, cursor: number): { start: number; end: number } {
  const start = text.lastIndexOf("\n", cursor - 1) + 1;
  const lineEnd = text.indexOf("\n", cursor);
  return { start, end: lineEnd === -1 ? text.length : lineEnd };
}

export function applyKey(state: EditorState, key: Key): EditorStep {
  switch (key.type) {
    case "char":
      return { state: insert(state, key.char) };
    case "paste":
      // Normalise CRLF/CR pastes; literal newlines insert, never submit.
      return { state: insert(state, key.text.replace(/\r\n?/g, "\n")) };
    case "newline":
      return { state: insert(state, "\n") };
    case "enter": {
      // `\` immediately before the cursor = escaped newline (CC parity).
      if (state.cursor > 0 && state.text[state.cursor - 1] === "\\") {
        const without = deleteRange(state, state.cursor - 1, state.cursor);
        return { state: insert(without, "\n") };
      }
      const text = state.text.trim();
      if (text === "") return { state };
      return { state: EMPTY_EDITOR, effect: { kind: "submit", text } };
    }
    case "backspace": {
      if (state.cursor === 0) return { state };
      return { state: deleteRange(state, step(state.text, state.cursor, -1), state.cursor) };
    }
    case "delete": {
      if (state.cursor >= state.text.length) return { state };
      return { state: deleteRange(state, state.cursor, step(state.text, state.cursor, 1)) };
    }
    case "left":
      return { state: { ...state, cursor: step(state.text, state.cursor, -1) } };
    case "right":
      return { state: { ...state, cursor: step(state.text, state.cursor, 1) } };
    case "home": {
      return { state: { ...state, cursor: lineBounds(state.text, state.cursor).start } };
    }
    case "end": {
      return { state: { ...state, cursor: lineBounds(state.text, state.cursor).end } };
    }
    case "ctrl-a":
      return applyKey(state, { type: "home" });
    case "ctrl-e":
      return applyKey(state, { type: "end" });
    case "ctrl-k": {
      const { end } = lineBounds(state.text, state.cursor);
      return { state: deleteRange(state, state.cursor, end) };
    }
    case "ctrl-u": {
      const { start } = lineBounds(state.text, state.cursor);
      return { state: deleteRange(state, start, state.cursor) };
    }
    case "ctrl-w":
      return { state: deleteRange(state, wordStart(state.text, state.cursor), state.cursor) };
    case "up": {
      const pos = cursorLine(state);
      if (pos.line === 0) return { state, effect: { kind: "history-up" } };
      return { state: moveVertical(state, -1) };
    }
    case "down": {
      const pos = cursorLine(state);
      if (pos.line === pos.lines - 1) return { state, effect: { kind: "history-down" } };
      return { state: moveVertical(state, 1) };
    }
    case "escape":
      return { state: EMPTY_EDITOR, effect: { kind: "escape" } };
    case "ctrl-c":
      return { state, effect: { kind: "interrupt" } };
    case "ctrl-d":
      return state.text === "" ? { state, effect: { kind: "exit" } } : { state };
    case "ctrl-l":
      return { state, effect: { kind: "redraw" } };
    case "tab":
    case "shift-tab":
      // Meaningful only while the slash menu is open; the controller
      // intercepts it there. Elsewhere a tab is ignored (no literal \t —
      // it would corrupt cursor math for no real use in a prompt).
      return { state };
  }
}

/** Move the cursor one logical line up/down, keeping the column when possible. */
function moveVertical(state: EditorState, dir: -1 | 1): EditorState {
  const lines = state.text.split("\n");
  let offset = 0;
  let row = 0;
  for (const [i, line] of lines.entries()) {
    if (state.cursor <= offset + line.length) {
      row = i;
      break;
    }
    offset += line.length + 1;
  }
  const col = state.cursor - offset;
  const target = row + dir;
  if (target < 0 || target >= lines.length) return state;
  let targetOffset = 0;
  for (let i = 0; i < target; i++) targetOffset += (lines[i] ?? "").length + 1;
  const targetLine = lines[target] ?? "";
  return { ...state, cursor: targetOffset + Math.min(col, targetLine.length) };
}
