/**
 * Transcript formatters — how engine events look in scrollback (Claude Code
 * visual vocabulary): `> prompt` echoes dim, assistant text leads with `⏺`,
 * tool calls are `⏺ describe` beats with `  ⎿ preview` results, errors red.
 * Pure: lines in, lines out; the Screen inserts them above the input region.
 */

import type { Palette } from "../colors.ts";
import { truncateWidth } from "./width.ts";

const RESULT_PREVIEW_LINES = 4;
const RESULT_PREVIEW_COLS = 160;

/** The submitted prompt, echoed into scrollback. */
export function userEcho(text: string, c: Palette): readonly string[] {
  return text.split("\n").map((line, i) => c.dim(i === 0 ? `> ${line}` : `  ${line}`));
}

/** A tool call beat: `⏺ bash(bun test)`. */
export function toolUseLine(describe: string, c: Palette): string {
  return `${c.green("⏺")} ${describe}`;
}

/**
 * A tool result preview: first lines, dimmed, `⎿`-bracketed, with an
 * honest `… +N lines` marker when truncated (the full output went to the
 * model, not the human — this is a beat, not a log).
 */
export function toolResultLines(output: string, isError: boolean, c: Palette): readonly string[] {
  const paint = isError ? c.red : c.dim;
  const all = output.split("\n");
  while (all.length > 1 && (all[all.length - 1] ?? "").trim() === "") all.pop();
  const shown = all.slice(0, RESULT_PREVIEW_LINES);
  const lines = shown.map((line, i) => {
    const head = i === 0 ? "  ⎿ " : "    ";
    return paint(`${head}${truncateWidth(line, RESULT_PREVIEW_COLS)}`);
  });
  if (all.length > shown.length) {
    lines.push(c.dim(`    … +${all.length - shown.length} lines`));
  }
  return lines;
}

/** Engine retry beat. */
export function retryLine(attempt: number, delayMs: number, reason: string, c: Palette): string {
  return c.dim(`  ↻ retry ${attempt} in ${delayMs}ms (${truncateWidth(reason, 120)})`);
}

export function errorLine(message: string, c: Palette): string {
  return c.red(`✗ ${message}`);
}

/** Terminal status line — only surfaced when the run did NOT succeed. */
export function doneLine(status: string, c: Palette): string | null {
  return status === "success" ? null : c.dim(`[${status}]`);
}

// ---------------------------------------------------------------------------
// Streaming assistant text
// ---------------------------------------------------------------------------

/**
 * Deltas accumulate; COMPLETE lines flush into scrollback as they form, and
 * the in-progress tail renders live in the bottom region. The first visible
 * line of a response gets the `⏺` lead; continuations indent two columns.
 * Immutable — each push returns the next flow plus the lines to flush.
 */
export interface TextFlow {
  readonly tail: string;
  /** True until the first non-empty line has been rendered. */
  readonly first: boolean;
}

export const EMPTY_FLOW: TextFlow = { tail: "", first: true };

export interface FlowStep {
  readonly flow: TextFlow;
  readonly flushed: readonly string[];
}

function decorate(line: string, first: boolean, c: Palette): { out: string; first: boolean } {
  if (line.trim() === "") return { out: "", first };
  return first
    ? { out: `${c.green("⏺")} ${line}`, first: false }
    : { out: `  ${line}`, first: false };
}

export function pushDelta(flow: TextFlow, delta: string, c: Palette): FlowStep {
  const parts = (flow.tail + delta).split("\n");
  const tail = parts.pop() ?? "";
  let first = flow.first;
  const flushed: string[] = [];
  for (const line of parts) {
    const d = decorate(line, first, c);
    flushed.push(d.out);
    first = d.first;
  }
  return { flow: { tail, first }, flushed };
}

/** Flush whatever tail remains at the end of a response. */
export function endFlow(flow: TextFlow, c: Palette): FlowStep {
  if (flow.tail.trim() === "") return { flow: EMPTY_FLOW, flushed: [] };
  const d = decorate(flow.tail, flow.first, c);
  return { flow: EMPTY_FLOW, flushed: [d.out] };
}

/** The live tail as shown in the bottom region while streaming (or null). */
export function tailLine(flow: TextFlow, c: Palette): string | null {
  if (flow.tail.trim() === "") return null;
  return decorate(flow.tail, flow.first, c).out;
}
