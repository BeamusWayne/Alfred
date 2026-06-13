/**
 * The Screen owns the terminal: a bottom-anchored REGION (input box, status
 * line, menus) repainted in place, with normal scrollback above it — the
 * same inline model Claude Code uses, deliberately NOT an alternate-screen
 * app (scrollback and copy/paste survive).
 *
 * Invariants that keep the repaint honest:
 *  - every painted region line is pre-truncated AND painted with terminal
 *    autowrap disabled, so one region line == one terminal row, always;
 *  - the cursor parks at a known (row, col) inside the region after every
 *    paint, so the next erase can find the region top from it.
 */

import { stripAnsi } from "./render.ts";
import { charWidth, strWidth } from "./width.ts";

export interface ScreenIo {
  write(s: string): void;
  readonly columns?: number;
  readonly rows?: number;
}

export interface RegionPaint {
  readonly lines: readonly string[];
  /** Cursor target inside `lines`; defaults to the end of the last line. */
  readonly cursorRow?: number;
  readonly cursorCol?: number;
  /** Hide the hardware cursor (status/approval views). */
  readonly hideCursor?: boolean;
}

export class Screen {
  private regionRows = 0;
  private cursorRowInRegion = 0;
  private cursorHidden = false;

  constructor(private readonly io: ScreenIo) {}

  get columns(): number {
    // `?? 80` is not enough: a detached PTY (CI, `script`) reports 0, and a
    // 0-column screen truncates every painted line to an ellipsis.
    const reported = this.io.columns;
    if (reported === undefined || reported <= 0) return 80;
    return Math.max(20, reported);
  }

  /** Erase the painted region and leave the cursor at its (former) top. */
  clearRegion(): void {
    if (this.regionRows === 0) return;
    const up = this.cursorRowInRegion;
    this.io.write(`\r${up > 0 ? `\x1b[${up}A` : ""}\x1b[0J`);
    this.regionRows = 0;
    this.cursorRowInRegion = 0;
  }

  /** Append lines to scrollback (above the region), then repaint `region`. */
  print(lines: readonly string[], region: RegionPaint): void {
    this.clearRegion();
    for (const line of lines) this.io.write(`${line}\n`);
    this.paint(region);
  }

  /** Repaint the bottom region only. */
  paint(region: RegionPaint): void {
    this.clearRegion();
    // Full width is safe: rows paint with autowrap disabled, so a line that
    // exactly fills the terminal cannot wrap — and the input box renders at
    // exactly `columns`, border to border.
    const width = this.columns;
    const rows = region.lines.map((line) => clipVisible(line, width));
    if (rows.length === 0) {
      this.setCursorHidden(region.hideCursor === true);
      return;
    }
    // Autowrap off: a mis-measured wide glyph clips instead of desyncing.
    this.io.write("\x1b[?7l");
    this.io.write(rows.join("\n"));
    this.io.write("\x1b[?7h");
    this.regionRows = rows.length;

    // The cursor now sits at the END of the last row; walk it to its target.
    const targetRow = region.cursorRow ?? rows.length - 1;
    const lastRow = rows.length - 1;
    const upBy = lastRow - Math.min(targetRow, lastRow);
    if (upBy > 0) this.io.write(`\x1b[${upBy}A`);
    this.io.write("\r");
    const col = region.cursorCol ?? strWidth(stripAnsi(rows[targetRow] ?? ""));
    if (col > 0) this.io.write(`\x1b[${col}C`);
    this.cursorRowInRegion = Math.min(targetRow, lastRow);
    this.setCursorHidden(region.hideCursor === true);
  }

  /** Tear down: erase the region and restore the cursor. */
  close(): void {
    this.clearRegion();
    this.setCursorHidden(false);
  }

  private setCursorHidden(hidden: boolean): void {
    if (hidden === this.cursorHidden) return;
    this.io.write(hidden ? "\x1b[?25l" : "\x1b[?25h");
    this.cursorHidden = hidden;
  }
}

/** Truncate by VISIBLE width, preserving ANSI styling and closing it. */
export function clipVisible(line: string, max: number): string {
  if (strWidth(stripAnsi(line)) <= max) return line;
  // Walk the string keeping SGR sequences intact while counting glyphs.
  let out = "";
  let used = 0;
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\x1b") {
      const end = line.indexOf("m", i);
      if (end === -1) break;
      out += line.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    const cp = line.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    const w = charWidth(ch);
    if (used + w > max - 2) break;
    out += ch;
    used += w;
    i += ch.length;
  }
  return `${out}…\x1b[0m`;
}
