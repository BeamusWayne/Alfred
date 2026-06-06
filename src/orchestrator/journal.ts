/**
 * Append-only JSONL journal for workflow step recording and resume/replay.
 *
 * ADR 0001 §5 (journal = resume + replay tape): every completed step is
 * persisted as an immutable JSONL line keyed by a monotonic sequence number
 * and an optional deterministic step key. On resume, `findByKey` returns the
 * cached result so idempotent steps are never re-executed. The full file is a
 * replay tape — reading it in order reconstructs the entire run's history.
 *
 * Concurrent writes are serialised through a promise chain (mirror of the
 * FileExporter pattern in src/telemetry/otel.ts) so interleaved appends
 * never produce corrupt JSONL lines.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface JournalEntry {
  readonly seq: number;
  readonly type: string;
  readonly key?: string;
  readonly label?: string;
  readonly data: unknown;
  readonly ts: number;
}

// ---------------------------------------------------------------------------
// Journal class
// ---------------------------------------------------------------------------

export class Journal {
  private readonly path: string;
  private readonly now: () => number;

  /**
   * Monotonically increasing counter. Incremented before each write so the
   * first entry has seq === 1. Lazy-initialised from the file on first append
   * to support reopen-and-continue semantics.
   */
  private seq: number = 0;
  private seqInitialised: boolean = false;

  /**
   * All writes are chained onto this promise so concurrent `append` calls
   * never interleave their read-then-write sequences (same safety model as
   * FileExporter in src/telemetry/otel.ts).
   */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(path: string, opts?: { readonly now?: () => number }) {
    this.path = path;
    this.now = opts?.now ?? ((): number => Date.now());
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Read every valid JSONL line from the file. Missing file returns `[]`.
   * Malformed lines are silently skipped (defensive; matches episodes.ts
   * pattern of returning null on parse failure).
   */
  private async readLines(): Promise<readonly JournalEntry[]> {
    const file = Bun.file(this.path);
    if (!(await file.exists())) return [];

    let text: string;
    try {
      text = await file.text();
    } catch {
      return [];
    }

    const entries: JournalEntry[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isJournalEntry(parsed)) {
          entries.push(parsed);
        }
      } catch {
        // malformed — skip
      }
    }
    return entries;
  }

  /**
   * Initialise `this.seq` from the highest seq already present in the file.
   * Called once, inside the write queue, before the first append.
   */
  private async initSeq(): Promise<void> {
    if (this.seqInitialised) return;
    const entries = await this.readLines();
    this.seq = entries.reduce((max, e) => Math.max(max, e.seq), 0);
    this.seqInitialised = true;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Append one entry to the journal. Assigns the next monotonic seq and stamps
   * the current time. The returned promise resolves only after the write has
   * landed on disk. Safe to call concurrently — writes are serialised.
   */
  append(entry: Omit<JournalEntry, "seq" | "ts">): Promise<JournalEntry> {
    let resolveEntry!: (e: JournalEntry) => void;
    const entryPromise = new Promise<JournalEntry>((resolve) => {
      resolveEntry = resolve;
    });

    this.writeQueue = this.writeQueue.then(async (): Promise<void> => {
      await this.initSeq();

      this.seq += 1;
      const full: JournalEntry = {
        ...entry,
        seq: this.seq,
        ts: this.now(),
      };

      const line = JSON.stringify(full) + "\n";
      const file = Bun.file(this.path);
      const prior = (await file.exists()) ? await file.text() : "";
      await Bun.write(this.path, prior + line);

      resolveEntry(full);
    });

    // Surface write errors to the caller while keeping the queue intact.
    return this.writeQueue.then(() => entryPromise);
  }

  /**
   * Parse and return all entries in the journal. Missing file returns `[]`.
   * Malformed lines are silently skipped.
   */
  readAll(): Promise<readonly JournalEntry[]> {
    return this.readLines();
  }

  /**
   * Find the last entry whose `key` matches the given string. Returns `null`
   * if not found. This is the resume primitive: "this step already completed →
   * return its cached `data` instead of re-executing."
   */
  async findByKey(key: string): Promise<JournalEntry | null> {
    const entries = await this.readLines();
    // Iterate in reverse to find the most-recent match.
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e !== undefined && e.key === key) return e;
    }
    return null;
  }

  /**
   * Await the pending write queue so callers can ensure all appends have
   * landed before process exit or teardown.
   */
  async close(): Promise<void> {
    await this.writeQueue;
  }
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

function isJournalEntry(v: unknown): v is JournalEntry {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj["seq"] === "number" &&
    typeof obj["type"] === "string" &&
    typeof obj["ts"] === "number" &&
    "data" in obj &&
    (obj["key"] === undefined || typeof obj["key"] === "string") &&
    (obj["label"] === undefined || typeof obj["label"] === "string")
  );
}
