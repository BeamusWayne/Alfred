/**
 * Multi-line sticky footer shared by the live CLI panels (`alfred run`,
 * `alfred watch`): event lines append and scroll normally (scrollback
 * survives — deliberately NOT an alternate-screen TUI); the footer block
 * (progress bar · counts · elapsed · spend, plus the current action) is
 * redrawn in place beneath them via cursor-up + erase-below.
 *
 * Renderers are pure and return plain strings; decoration (dim) and width
 * truncation happen at the IO edge in `StickyFooter`.
 */

// ---------------------------------------------------------------------------
// Pure renderers
// ---------------------------------------------------------------------------

export interface FooterState {
  /** Features resolved so far. */
  readonly resolved: number;
  /** Total features when a readable list provides one. */
  readonly total: number | null;
  readonly costUsd: number;
  readonly elapsedMs: number;
  /** Current action, e.g. `implement:auth#2 · bash(bun test)`. */
  readonly current?: string;
}

const BAR_CELLS = 10;

/** `▮▮▮▮▮▯▯▯▯▯` scaled to ten cells; unknown total renders an empty track. */
export function progressBar(resolved: number, total: number | null): string {
  if (total === null || total <= 0) return "▯".repeat(BAR_CELLS);
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round((resolved / total) * BAR_CELLS)));
  return "▮".repeat(filled) + "▯".repeat(BAR_CELLS - filled);
}

/** `0:00`, `2:14`, `1:02:05` — hours only when nonzero. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
  return `${minutes}:${seconds}`;
}

/** One or two plain lines: the stats head, plus the current action if known. */
export function renderFooterLines(state: FooterState): readonly string[] {
  const features = state.total === null ? `${state.resolved}` : `${state.resolved}/${state.total}`;
  const head =
    `${progressBar(state.resolved, state.total)} ${features} features · ` +
    `⏱ ${formatElapsed(state.elapsedMs)} · $${state.costUsd.toFixed(4)}`;
  return state.current === undefined ? [head] : [head, `▸ ${state.current}`];
}

/**
 * Terminal display width, counted conservatively: ASCII is 1 column,
 * everything else 2. CJK is genuinely double-width, and the panel's own
 * glyphs (▮ ▯ ▸ · ⏱ ⚙) are East-Asian-AMBIGUOUS — CJK-configured terminals
 * render those double too (this corrupted the live footer: a wrapped footer
 * occupies more rows than the cursor-up erase accounts for). Over-counting
 * only shortens a line; under-counting wraps it.
 */
export function displayWidth(line: string): number {
  let width = 0;
  for (const ch of line) width += (ch.codePointAt(0) ?? 0) < 0x80 ? 1 : 2;
  return width;
}

const ELLIPSIS_WIDTH = 2; // … is ambiguous-width as well

/** Hard cap a line to `max` display columns, ellipsizing the overflow. */
export function truncateVisible(line: string, max: number): string {
  if (displayWidth(line) <= max) return line;
  let out = "";
  let used = 0;
  for (const ch of line) {
    const w = (ch.codePointAt(0) ?? 0) < 0x80 ? 1 : 2;
    if (used + w > max - ELLIPSIS_WIDTH) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

/** The slice of a writable TTY stream the footer needs (process.stderr fits). */
export interface FooterIo {
  write(s: string): void;
  readonly columns?: number;
}

const MIN_WIDTH = 20;

/**
 * Owns the redraw cycle. `print(events, footer)` appends the event lines and
 * repaints the footer beneath them; `clear()` erases the footer (call before
 * handing the terminal back). When disabled (not a TTY / NO_COLOR), events
 * pass through and the footer is dropped entirely.
 */
export class StickyFooter {
  private shown = 0;

  constructor(
    private readonly io: FooterIo,
    private readonly enabled: boolean,
    private readonly decorate: (s: string) => string,
  ) {}

  clear(): void {
    if (!this.enabled || this.shown === 0) return;
    this.io.write(`\x1b[${this.shown}A\x1b[0J`);
    this.shown = 0;
  }

  print(events: readonly string[], footer: readonly string[]): void {
    if (!this.enabled) {
      for (const line of events) this.io.write(`${line}\n`);
      return;
    }
    this.clear();
    for (const line of events) this.io.write(`${line}\n`);
    if (footer.length === 0) return;
    // Belt and braces: width-truncated AND painted with autowrap disabled,
    // so a mis-measured glyph clips instead of desynchronising the erase.
    const width = Math.max(MIN_WIDTH, (this.io.columns ?? 80) - 1);
    this.io.write("\x1b[?7l");
    for (const line of footer) this.io.write(`${this.decorate(truncateVisible(line, width))}\n`);
    this.io.write("\x1b[?7h");
    this.shown = footer.length;
  }
}
