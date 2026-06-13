/**
 * Pure renderers for the TUI's bottom region: the bordered input box (with
 * wrapping and an exact cursor position), the slash-command menu, the
 * status/spinner line, and the approval panel. Everything returns plain
 * lines + coordinates; ANSI styling comes from the injected Palette and the
 * Screen owns all cursor movement.
 *
 * Width math is standard East Asian Width (width.ts): CJK is 2 columns,
 * the UI's own glyphs (─ ✻ ⏺ ·) are 1 — borders align AND repaints can't
 * desync, because the Screen clips with the same model.
 */

import type { ApprovalRequest } from "../../query/types.ts";
import type { Palette } from "../colors.ts";
import { formatElapsed } from "../footer.ts";
import type { EditorState } from "./editor.ts";
import type { MenuState } from "./slash.ts";
import { strWidth, truncateWidth, wrapWidth } from "./width.ts";

export const MIN_COLUMNS = 30;

/** Hard-wrap by display columns (standard EAW — see width.ts). */
export { wrapWidth as wrapVisible };

export interface RenderedBox {
  readonly lines: readonly string[];
  /** Cursor position into `lines` (row) / display columns (col). */
  readonly cursorRow: number;
  readonly cursorCol: number;
}

const PROMPT = "> ";
const CONT = "  ";

/**
 * The bordered input box. Content wraps inside the border; the cursor's
 * (row, col) is computed with the same wrap walk that produced the lines,
 * so they can never disagree.
 */
export function renderInputBox(
  editor: EditorState,
  columns: number,
  c: Palette,
  placeholder: string,
): RenderedBox {
  const width = Math.max(MIN_COLUMNS, columns);
  const inner = width - 4; // "│ " + " │"
  const contentWidth = inner - PROMPT.length;

  interface Visual {
    readonly text: string;
    readonly prefix: string;
  }
  const visuals: Visual[] = [];
  let cursorRow = 0;
  let cursorCol = PROMPT.length;

  let consumed = 0;
  const logical = editor.text.split("\n");
  for (const [i, line] of logical.entries()) {
    const segments = wrapWidth(line, contentWidth);
    let offset = 0;
    for (const [j, segment] of segments.entries()) {
      const prefix = i === 0 && j === 0 ? PROMPT : CONT;
      visuals.push({ text: segment, prefix });
      const start = consumed + offset;
      const end = start + segment.length;
      const isLast = i === logical.length - 1 && j === segments.length - 1;
      if (editor.cursor >= start && (editor.cursor < end || (isLast && editor.cursor === end))) {
        cursorRow = visuals.length - 1;
        cursorCol = prefix.length + strWidth(segment.slice(0, editor.cursor - start));
      } else if (editor.cursor === end && !isLast && j === segments.length - 1) {
        // Cursor sitting on a logical newline boundary belongs to this row's end.
        cursorRow = visuals.length - 1;
        cursorCol = prefix.length + strWidth(segment);
      }
      offset += segment.length;
    }
    consumed += line.length + 1; // + the \n
  }

  const top = c.dim(`╭${"─".repeat(width - 2)}╮`);
  const bottom = c.dim(`╰${"─".repeat(width - 2)}╯`);
  const bar = c.dim("│");

  const body = visuals.map(({ text, prefix }) => {
    const isEmpty = editor.text === "";
    const raw = isEmpty ? truncateWidth(placeholder, contentWidth) : text;
    const pad = Math.max(0, inner - prefix.length - strWidth(raw));
    const content = isEmpty ? c.dim(raw) : raw;
    const promptPaint = prefix === PROMPT ? c.bold(prefix) : prefix;
    return `${bar} ${promptPaint}${content}${" ".repeat(pad)} ${bar}`;
  });

  return {
    lines: [top, ...body, bottom],
    cursorRow: 1 + cursorRow,
    cursorCol: 2 + cursorCol, // "│ " before content
  };
}

/** The dim hint line under the box (left) with session cost (right). */
export function renderHint(columns: number, c: Palette, costUsd: number, model: string): string {
  const left = "⏎ send · \\⏎ newline · / commands · esc clear · ctrl-c quit";
  const right = costUsd > 0 ? `${model} · $${costUsd.toFixed(4)}` : model;
  const width = Math.max(MIN_COLUMNS, columns);
  const gap = width - strWidth(left) - strWidth(right) - 4;
  if (gap < 1) return c.dim(truncateWidth(`  ${left}`, width - 1));
  return c.dim(`  ${left}${" ".repeat(gap)}${right}`);
}

/** Slash menu rows: `❯ /name args  description`, selection highlighted. */
export function renderMenu(menu: MenuState, columns: number, c: Palette): readonly string[] {
  const width = Math.max(MIN_COLUMNS, columns);
  const nameWidth = Math.max(...menu.matches.map((m) => m.name.length + (m.args ? m.args.length + 1 : 0)), 8);
  return menu.matches.map((m, i) => {
    const sel = i === menu.selected;
    const name = `/${m.name}${m.args ? ` ${m.args}` : ""}`.padEnd(nameWidth + 1);
    const row = `  ${sel ? "❯" : " "} ${name}  ${m.description}`;
    const clipped = truncateWidth(row, width - 1);
    return sel ? c.bold(clipped) : c.dim(clipped);
  });
}

export const SPINNER_FRAMES = ["·", "✢", "✳", "✻", "✽", "✻", "✳", "✢"] as const;

export interface StatusState {
  readonly tick: number;
  readonly label: string;
  readonly startedMs: number;
  readonly nowMs: number;
  readonly costUsd: number;
}

/** `✻ Working… (esc to interrupt · 0:12 · $0.0034)` */
export function renderStatus(s: StatusState, columns: number, c: Palette): string {
  const frame = SPINNER_FRAMES[s.tick % SPINNER_FRAMES.length] ?? "✻";
  const cost = s.costUsd > 0 ? ` · $${s.costUsd.toFixed(4)}` : "";
  const line = `${c.green(frame)} ${s.label}… ${c.dim(`(esc to interrupt · ${formatElapsed(s.nowMs - s.startedMs)}${cost})`)}`;
  return truncateWidth(line, Math.max(MIN_COLUMNS, columns) + 16); // +ANSI slack
}

export const APPROVAL_OPTIONS = ["yes", "always", "no"] as const;
export type ApprovalChoice = (typeof APPROVAL_OPTIONS)[number];

/** The interactive approval panel (↑/↓ + enter, or y/a/n shortcuts). */
export function renderApproval(
  req: ApprovalRequest,
  selected: number,
  columns: number,
  c: Palette,
): readonly string[] {
  const width = Math.max(MIN_COLUMNS, columns);
  const reason = req.reason ? ` ${c.dim(`(${req.reason})`)}` : "";
  const rows: Array<{ label: string; key: string }> = [
    { label: "yes — run it once", key: "y" },
    { label: `yes — always allow ${req.toolName} this session`, key: "a" },
    { label: "no — deny", key: "n · esc" },
  ];
  return [
    truncateWidth(`${c.yellow("⚠ approve")} ${req.description}?${reason}`, width + 16),
    ...rows.map((row, i) => {
      const sel = i === selected;
      const line = `  ${sel ? "❯" : " "} ${row.label}  ${c.dim(row.key)}`;
      return sel ? c.bold(truncateWidth(line, width + 16)) : c.dim(truncateWidth(line, width + 16));
    }),
  ];
}

/** The welcome banner printed once into scrollback at session start. */
export function renderBanner(
  opts: { version: string; model: string; provider: string; cwd: string; mock: boolean },
  columns: number,
  c: Palette,
): readonly string[] {
  const width = Math.max(MIN_COLUMNS, Math.min(columns, 78));
  const inner = width - 4;
  const row = (s: string) =>
    `${c.dim("│")} ${s}${" ".repeat(Math.max(0, inner - strWidth(stripAnsi(s))))} ${c.dim("│")}`;
  const model = opts.mock ? `${opts.model} ${c.yellow("(scripted — no API calls)")}` : opts.model;
  return [
    c.dim(`╭${"─".repeat(width - 2)}╮`),
    row(`${c.green("✻")} ${c.bold(`Alfred v${opts.version}`)} — at your service`),
    row(c.dim(`${opts.provider} · ${model}`)),
    row(c.dim(`cwd ${truncateWidth(opts.cwd, inner - 5)}`)),
    c.dim(`╰${"─".repeat(width - 2)}╯`),
  ];
}

/** Strip ANSI SGR sequences — banner padding must measure visible glyphs. */
export function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the point
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
