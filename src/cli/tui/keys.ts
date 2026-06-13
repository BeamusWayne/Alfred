/**
 * Raw-mode key decoding for the TUI. Three things make this non-trivial and
 * they all matter for real input:
 *
 *  1. UTF-8 arrives split across chunks (CJK and IME input especially) — a
 *     streaming TextDecoder reassembles code points before tokenizing.
 *  2. Escape sequences arrive split across chunks too — a lone ESC at a
 *     chunk boundary is held briefly (injectable timer) before being
 *     emitted as the Esc key, so arrow keys never decay into [ + A.
 *  3. Bracketed paste (ESC[200~ … ESC[201~) is decoded as ONE paste event,
 *     so pasted multi-line text inserts newlines instead of submitting.
 */

export type Key =
  | { readonly type: "char"; readonly char: string }
  | { readonly type: "paste"; readonly text: string }
  | {
      readonly type:
        | "enter"
        | "newline" // ctrl-j / alt-enter
        | "backspace"
        | "delete"
        | "left"
        | "right"
        | "up"
        | "down"
        | "home"
        | "end"
        | "escape"
        | "tab"
        | "shift-tab"
        | "ctrl-a"
        | "ctrl-c"
        | "ctrl-d"
        | "ctrl-e"
        | "ctrl-k"
        | "ctrl-l"
        | "ctrl-u"
        | "ctrl-w";
    };

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const ESC_HOLD_MS = 25;

const CTRL: Readonly<Record<string, Key>> = {
  "\x01": { type: "ctrl-a" },
  "\x03": { type: "ctrl-c" },
  "\x04": { type: "ctrl-d" },
  "\x05": { type: "ctrl-e" },
  "\x08": { type: "backspace" },
  "\x09": { type: "tab" },
  "\x0a": { type: "newline" },
  "\x0b": { type: "ctrl-k" },
  "\x0c": { type: "ctrl-l" },
  "\x0d": { type: "enter" },
  "\x15": { type: "ctrl-u" },
  "\x17": { type: "ctrl-w" },
  "\x7f": { type: "backspace" },
};

/** CSI final-byte sequences we care about; everything else is swallowed. */
const CSI: Readonly<Record<string, Key>> = {
  A: { type: "up" },
  B: { type: "down" },
  C: { type: "right" },
  D: { type: "left" },
  F: { type: "end" },
  H: { type: "home" },
  Z: { type: "shift-tab" },
  "1~": { type: "home" },
  "3~": { type: "delete" },
  "4~": { type: "end" },
  "7~": { type: "home" },
  "8~": { type: "end" },
};

export interface DecoderTimer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMER: DecoderTimer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Stateful decoder: feed raw Buffers, receive Key events via the callback.
 * Order is preserved; the only asynchrony is the ESC-hold described above.
 */
export class KeyDecoder {
  private readonly utf8 = new TextDecoder("utf-8");
  private pending = "";
  private inPaste = false;
  private pasteBuf = "";
  private escTimer: unknown = null;

  constructor(
    private readonly emit: (key: Key) => void,
    private readonly timer: DecoderTimer = REAL_TIMER,
  ) {}

  feed(chunk: Buffer | string): void {
    if (this.escTimer !== null) {
      this.timer.clear(this.escTimer);
      this.escTimer = null;
    }
    const text =
      typeof chunk === "string" ? chunk : this.utf8.decode(chunk, { stream: true });
    this.pending += text;
    this.drain();
  }

  /** Flush an ESC held at a chunk boundary (also used by tests). */
  flushEscape(): void {
    if (this.pending.startsWith("\x1b")) {
      this.pending = this.pending.slice(1);
      this.emit({ type: "escape" });
      this.drain();
    }
  }

  private drain(): void {
    while (this.pending.length > 0) {
      if (this.inPaste) {
        const end = this.pending.indexOf(PASTE_END);
        if (end === -1) {
          // Paste body may legitimately end in a partial ESC sequence.
          const safe = this.pending.lastIndexOf("\x1b");
          const cut = safe === -1 ? this.pending.length : safe;
          this.pasteBuf += this.pending.slice(0, cut);
          this.pending = this.pending.slice(cut);
          return;
        }
        this.pasteBuf += this.pending.slice(0, end);
        this.pending = this.pending.slice(end + PASTE_END.length);
        this.inPaste = false;
        this.emit({ type: "paste", text: this.pasteBuf });
        this.pasteBuf = "";
        continue;
      }

      const ch = this.pending[0] ?? "";
      if (ch !== "\x1b") {
        const mapped = CTRL[ch];
        this.pending = this.pending.slice(1);
        if (mapped) {
          this.emit(mapped);
        } else if (ch >= " " || ch === "\t") {
          this.emit({ type: "char", char: ch });
        }
        continue;
      }

      // ESC-prefixed: paste start, CSI, SS3, alt+enter, or a lone Esc key.
      if (this.pending.startsWith(PASTE_START)) {
        this.pending = this.pending.slice(PASTE_START.length);
        this.inPaste = true;
        continue;
      }
      if (this.pending.length === 1) {
        // Might be a split sequence — hold briefly, then emit Esc.
        this.escTimer = this.timer.set(() => {
          this.escTimer = null;
          this.flushEscape();
        }, ESC_HOLD_MS);
        return;
      }
      const next = this.pending[1] ?? "";
      if (next === "\r" || next === "\n") {
        this.pending = this.pending.slice(2);
        this.emit({ type: "newline" }); // alt/option+enter
        continue;
      }
      if (next === "[" || next === "O") {
        const seq = this.takeCsi();
        if (seq === null) return; // incomplete — wait for more bytes
        const mapped = CSI[seq];
        if (mapped) this.emit(mapped);
        continue;
      }
      // ESC + other (alt-<char> chords we don't bind): swallow both.
      this.pending = this.pending.slice(2);
    }
  }

  /**
   * Consume `ESC [ params final` (or `ESC O final`) from `pending` and
   * return `params+final`; null when the sequence is still incomplete.
   */
  private takeCsi(): string | null {
    let i = 2; // past ESC and [ / O
    while (i < this.pending.length) {
      const ch = this.pending[i] ?? "";
      if (ch >= "@" && ch <= "~") {
        const body = this.pending.slice(2, i + 1);
        this.pending = this.pending.slice(i + 1);
        return body;
      }
      i++;
    }
    return null;
  }
}
