/**
 * `alfred watch` — a read-only live panel over a run's on-disk record:
 * tail-follow `journal.jsonl` (agent-level entries) and `ledger.jsonl`
 * (feature-level receipt rows), render one line per entry, and keep a sticky
 * status line (elapsed · progress · cost) redrawn in place on stderr.
 *
 * Everything the panel shows is read from the same files the run signs, so
 * watching is literally reading the receipt as it is written. A finished run
 * renders fully and exits (replay mode); an in-flight run is followed until
 * its `run_end` row lands. No alternate screen, no new dependencies —
 * appended lines plus one redrawn status line.
 *
 * Pure pieces (`splitJsonl`, `render*`, `formatElapsed`) are exported for
 * unit tests; all IO goes through the injected `WatchIo`.
 */
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { loadFeatureList } from "../harness/featureList.ts";
import { colorEnabled, type Palette, palette } from "./colors.ts";
import { renderFooterLines, StickyFooter } from "./footer.ts";

// ---------------------------------------------------------------------------
// Incremental JSONL parsing (byte-level, so multi-byte UTF-8 survives chunking)
// ---------------------------------------------------------------------------

export interface JsonlSplit {
  /** Bytes after the last newline — prepend to the next chunk. */
  readonly carry: Uint8Array;
  readonly values: readonly unknown[];
}

const NEWLINE = 0x0a;
const utf8 = new TextDecoder();

/**
 * Split `carry + chunk` into parsed JSON values, one per complete line.
 * Torn or corrupt lines are skipped (a tail reader may catch a write
 * mid-flush; the next poll sees the completed line).
 */
export function splitJsonl(carry: Uint8Array, chunk: Uint8Array): JsonlSplit {
  const buf = new Uint8Array(carry.length + chunk.length);
  buf.set(carry, 0);
  buf.set(chunk, carry.length);
  const values: unknown[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== NEWLINE) continue;
    const line = utf8.decode(buf.slice(start, i)).trim();
    start = i + 1;
    if (line === "") continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      // Incomplete or corrupt line — skip; integrity is the ledger's job.
    }
  }
  return { carry: buf.slice(start), values };
}

// ---------------------------------------------------------------------------
// Line renderers — pure: value in, string out (null = nothing to print)
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Render a journal entry (`agent`, `activity`, `log`; anything else is null). */
export function renderJournalEntry(value: unknown, c: Palette): string | null {
  if (!isRecord(value)) return null;
  const data = isRecord(value["data"]) ? value["data"] : undefined;
  if (value["type"] === "log") {
    const message = typeof data?.["message"] === "string" ? data["message"] : "";
    return c.dim(`· ${message}`);
  }
  if (value["type"] === "activity") {
    // Live tool beats: a line per call; results stay silent unless they fail
    // (the next beat or the agent row already implies success).
    if (data?.["event"] === "tool_use" && typeof data["describe"] === "string") {
      return c.dim(`  ⚙ ${data["describe"]}`);
    }
    if (data?.["event"] === "tool_result" && data["isError"] === true) {
      const name = typeof data["name"] === "string" ? data["name"] : "tool";
      return c.red(`  ✗ ${name} failed`);
    }
    return null;
  }
  if (value["type"] !== "agent" || typeof value["label"] !== "string" || data === undefined) {
    return null;
  }
  const mark = data["status"] === "success" ? c.green("✓") : c.red("✗");
  const parts = [`⚙ ${value["label"]} ${mark}`];
  const cost = isRecord(data["cost"]) ? data["cost"]["usd"] : undefined;
  if (typeof cost === "number") parts.push(`$${cost.toFixed(4)}`);
  if (typeof data["turns"] === "number") parts.push(`${data["turns"]} turns`);
  return parts.join(" · ");
}

/** Render a ledger row (`feature` and `run_end` kinds; anything else is null). */
export function renderLedgerRow(value: unknown, c: Palette): string | null {
  if (!isRecord(value) || !isRecord(value["data"])) return null;
  const data = value["data"];
  if (value["kind"] === "feature" && typeof data["feature"] === "string") {
    const status = typeof data["status"] === "string" ? data["status"] : "?";
    const mark = status === "passing" ? c.green("✓") : c.red("✗");
    const parts = [`${mark} ${data["feature"]} ${status}`];
    if (typeof data["verifyExit"] === "number") parts.push(`verify exit ${data["verifyExit"]}`);
    if (typeof data["rubric"] === "number") parts.push(`rubric ${data["rubric"]}`);
    return parts.join(" · ");
  }
  if (value["kind"] === "run_end") {
    const passing = typeof data["passing"] === "number" ? data["passing"] : 0;
    const blocked = typeof data["blocked"] === "number" ? data["blocked"] : 0;
    const stopped = typeof data["stopped"] === "string" ? data["stopped"] : "?";
    return c.bold(`run end: ${passing} passing · ${blocked} blocked · ${stopped}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

export interface WatchIo {
  /** Print one event line (stdout). */
  readonly out: (line: string) => void;
  /** Redraw the sticky footer block (stderr; no-op when not a TTY). */
  readonly status: (lines: readonly string[]) => void;
  /** Erase the sticky footer, if visible. */
  readonly clearStatus: () => void;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface WatchOptions {
  readonly palette: Palette;
  readonly pollMs?: number;
  /** Optional feature_list.json giving the status line a total. */
  readonly featureListPath?: string;
}

const DEFAULT_POLL_MS = 500;

interface Tail {
  readonly offset: number;
  readonly carry: Uint8Array;
}

const FRESH_TAIL: Tail = { offset: 0, carry: new Uint8Array(0) };

interface TailRead {
  readonly tail: Tail;
  readonly values: readonly unknown[];
}

/** Read bytes appended since `tail.offset`; missing files yield nothing. */
async function readNew(path: string, tail: Tail): Promise<TailRead> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { tail, values: [] };
  const size = file.size;
  if (size <= tail.offset) return { tail, values: [] };
  const bytes = new Uint8Array(await file.slice(tail.offset, size).arrayBuffer());
  const split = splitJsonl(tail.carry, bytes);
  return { tail: { offset: size, carry: split.carry }, values: split.values };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function entryTs(value: unknown): number | null {
  return isRecord(value) && typeof value["ts"] === "number" ? value["ts"] : null;
}

/** `label · describe` for a tool_use activity entry; undefined otherwise. */
function activityCurrent(value: unknown): string | undefined {
  if (!isRecord(value) || value["type"] !== "activity" || !isRecord(value["data"])) {
    return undefined;
  }
  const data = value["data"];
  if (data["event"] !== "tool_use" || typeof data["describe"] !== "string") return undefined;
  const label = typeof value["label"] === "string" ? value["label"] : "agent";
  return `${label} · ${data["describe"]}`;
}

function agentCostUsd(value: unknown): number {
  if (!isRecord(value) || value["type"] !== "agent" || !isRecord(value["data"])) return 0;
  const cost = value["data"]["cost"];
  return isRecord(cost) && typeof cost["usd"] === "number" ? cost["usd"] : 0;
}

async function featureTotal(path: string | undefined): Promise<number | null> {
  if (path === undefined) return null;
  try {
    return (await loadFeatureList(path)).features.length;
  } catch {
    return null; // absent or invalid list — the panel just omits the total
  }
}

/**
 * Follow `runDir` until its ledger records `run_end` (exit 0). A run that has
 * already ended renders fully in the first poll and exits immediately.
 * Returns 1 when `runDir` is not a directory.
 */
export async function watchRun(runDir: string, io: WatchIo, opts: WatchOptions): Promise<number> {
  const c = opts.palette;
  if (!(await isDirectory(runDir))) {
    io.out(c.red(`No run found at ${runDir}`));
    return 1;
  }
  const journalPath = join(runDir, "journal.jsonl");
  const ledgerPath = join(runDir, "ledger.jsonl");
  const runId = basename(runDir);
  const startedAt = io.now();
  io.out(c.dim(`· watching ${runId}`));

  let journalTail = FRESH_TAIL;
  let ledgerTail = FRESH_TAIL;
  let costUsd = 0;
  let resolved = 0;
  let ended = false;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let current: string | undefined;

  const track = (value: unknown): void => {
    const ts = entryTs(value);
    if (ts === null) return;
    firstTs = firstTs === null ? ts : Math.min(firstTs, ts);
    lastTs = lastTs === null ? ts : Math.max(lastTs, ts);
  };

  for (;;) {
    const journal = await readNew(journalPath, journalTail);
    journalTail = journal.tail;
    const ledger = await readNew(ledgerPath, ledgerTail);
    ledgerTail = ledger.tail;

    for (const value of journal.values) {
      track(value);
      costUsd += agentCostUsd(value);
      const beat = activityCurrent(value);
      if (beat !== undefined) current = beat;
      // An agent row closes its activity stream — nothing is in flight.
      if (isRecord(value) && value["type"] === "agent") current = undefined;
      const line = renderJournalEntry(value, c);
      if (line !== null) io.out(line);
    }
    for (const value of ledger.values) {
      track(value);
      if (isRecord(value) && value["kind"] === "feature") resolved += 1;
      if (isRecord(value) && value["kind"] === "run_end") ended = true;
      const line = renderLedgerRow(value, c);
      if (line !== null) io.out(line);
    }

    const elapsedMs =
      ended && firstTs !== null && lastTs !== null
        ? lastTs - firstTs
        : io.now() - (firstTs ?? startedAt);
    const total = await featureTotal(opts.featureListPath);
    io.status(renderFooterLines({ resolved, total, costUsd, elapsedMs, current }));

    if (ended) {
      io.clearStatus();
      return 0;
    }
    await io.sleep(opts.pollMs ?? DEFAULT_POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// CLI wiring (the only process-global IO in this module)
// ---------------------------------------------------------------------------

/**
 * Resolve what to watch: an explicit run directory or ledger/journal path,
 * else the newest run directory under `<cwd>/.alfred/workflows`. Unlike
 * `findLatestLedger` (verify semantics — the receipt must exist), this
 * accepts a run whose journal/ledger have not been created yet: a live
 * attach typically happens before the run's first append, and `watchRun`
 * polls until the files appear. Null when nothing exists to watch.
 */
export async function resolveWatchDir(cwd: string, arg?: string): Promise<string | null> {
  if (arg !== undefined && arg !== "") {
    const path = resolve(cwd, arg);
    return path.endsWith(".jsonl") ? dirname(path) : path;
  }
  const root = join(cwd, ".alfred", "workflows");
  let runIds: readonly string[];
  try {
    runIds = await readdir(root);
  } catch {
    return null; // no .alfred/workflows directory at all
  }
  // Run ids are ISO timestamps with ":"/"." replaced by "-", so reverse
  // lexicographic order is reverse chronological.
  for (const runId of [...runIds].sort().reverse()) {
    const candidate = join(root, runId);
    if (await isDirectory(candidate)) return candidate;
  }
  return null;
}

/** Event lines to stdout; sticky footer block on stderr when it is a TTY. */
export function standardWatchIo(): WatchIo {
  const footer = new StickyFooter(
    process.stderr,
    colorEnabled(process.stderr),
    palette(process.stderr).dim,
  );
  return {
    out: (line) => {
      footer.clear();
      process.stdout.write(`${line}\n`);
    },
    status: (lines) => footer.print([], lines),
    clearStatus: () => footer.clear(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  };
}
