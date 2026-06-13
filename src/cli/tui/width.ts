/**
 * Terminal display width for the TUI — standard East Asian Width semantics
 * (ambiguous = 1 column, like Claude Code's string-width), NOT footer.ts's
 * conservative everything-non-ASCII-is-2 rule. The difference matters here:
 * the input box pads to align its right border, and over-counting `─ ✻ ⏺ ·`
 * (all EAW-ambiguous, rendered 1 column by virtually every terminal) pushes
 * the border off the edge. footer.ts keeps its rule on purpose — there,
 * over-counting only shortens a truncation, it never misaligns a border.
 */

/** EAW Wide/Fullwidth ranges (condensed; covers CJK, Hangul, kana, emoji). */
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2329, 0x232a],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe52],
  [0xfe54, 0xfe66],
  [0xfe68, 0xfe6b],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

/** Zero-width: combining marks, ZWSP/ZWJ family, variation selectors. */
const ZERO: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f],
  [0x200b, 0x200f],
  [0xfe00, 0xfe0f],
  [0x1ab0, 0x1aff],
  [0x20d0, 0x20ff],
];

function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  for (const [lo, hi] of ranges) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

export function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x20) return 0; // control
  if (cp < 0x7f) return 1; // printable ASCII
  if (inRanges(cp, ZERO)) return 0;
  return inRanges(cp, WIDE) ? 2 : 1;
}

export function strWidth(s: string): number {
  let width = 0;
  for (const ch of s) width += charWidth(ch);
  return width;
}

/** Hard cap a line to `max` columns, ellipsizing the overflow. */
export function truncateWidth(line: string, max: number): string {
  if (strWidth(line) <= max) return line;
  let out = "";
  let used = 0;
  for (const ch of line) {
    const w = charWidth(ch);
    if (used + w > max - 1) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

/** Hard-wrap one logical line into segments of at most `width` columns. */
export function wrapWidth(line: string, width: number): readonly string[] {
  if (width <= 0) return [line];
  const out: string[] = [];
  let segment = "";
  let used = 0;
  for (const ch of line) {
    const w = charWidth(ch);
    if (used + w > width && segment !== "") {
      out.push(segment);
      segment = "";
      used = 0;
    }
    segment += ch;
    used += w;
  }
  out.push(segment);
  return out;
}
