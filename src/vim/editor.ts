export type VimMode = "INSERT" | "NORMAL";

export interface InputKey {
  escape: boolean;
  return: boolean;
  backspace: boolean;
  delete: boolean;
  ctrl: boolean;
  meta: boolean;
}

export interface VimEditor {
  getMode(): VimMode;
  getValue(): string;
  getCursor(): number;
  setValue(value: string): void;
  processInput(char: string, key: InputKey): void;
}

export function createVimEditor(): VimEditor {
  let mode: VimMode = "INSERT";
  let value = "";
  let cursor = 0;
  let pendingOp = "";

  return {
    getMode() {
      return mode;
    },

    getValue() {
      return value;
    },

    getCursor() {
      return cursor;
    },

    setValue(newValue: string) {
      value = newValue;
      cursor = newValue.length;
    },

    processInput(char: string, key: InputKey) {
      if (key.escape) {
        if (mode === "INSERT") {
          mode = "NORMAL";
          pendingOp = "";
          if (cursor > 0) cursor--;
        }
        return;
      }

      if (mode === "INSERT") {
        if (key.backspace || key.delete) {
          if (cursor > 0) {
            value = value.slice(0, cursor - 1) + value.slice(cursor);
            cursor--;
          }
          return;
        }

        if (key.return) return;

        if (char && !key.ctrl && !key.meta) {
          value = value.slice(0, cursor) + char + value.slice(cursor);
          cursor++;
        }
        return;
      }

      // NORMAL mode
      if (key.backspace || key.delete) return;
      if (key.return) return;

      if (!char || key.ctrl || key.meta) return;

      // Pending 'd' operator
      if (pendingOp === "d") {
        if (char === "d") {
          value = "";
          cursor = 0;
        }
        pendingOp = "";
        return;
      }

      switch (char) {
        case "i":
          mode = "INSERT";
          break;
        case "a":
          mode = "INSERT";
          if (cursor < value.length) cursor++;
          break;
        case "h":
          if (cursor > 0) cursor--;
          break;
        case "l":
          if (cursor < value.length) cursor++;
          break;
        case "x":
          if (cursor < value.length) {
            value = value.slice(0, cursor) + value.slice(cursor + 1);
            if (cursor > value.length) cursor = value.length;
          }
          break;
        case "d":
          pendingOp = "d";
          break;
        case "0":
          cursor = 0;
          break;
        case "$":
          cursor = value.length > 0 ? value.length - 1 : 0;
          break;
        default:
          pendingOp = "";
          break;
      }
    },
  };
}
