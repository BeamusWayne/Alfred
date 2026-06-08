/**
 * HMAC-signed, hash-chained run ledger — ADR 0001 §5.3 + ADR 0004 (signed,
 * replayable run ledger / Proof Receipt).
 *
 * Every harness step appends a row to a JSONL file. Each entry's signature
 * covers the canonical serialisation of the entry payload (stable key order)
 * concatenated with the previous entry's signature, forming a hash chain.
 * Any edit, reorder, or truncation of stored entries is detectable via
 * `Ledger.verify()`.
 *
 * Secret-shaped strings in the data are redacted before signing (ADR 0003), so
 * the receipt is safe to share. The genesis entry (seq 0) uses a fixed 64-zero
 * string as its `prevSig` anchor so the chain is self-contained.
 */

import { createHmac } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { redact } from "../security/redact.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LedgerPayload {
  readonly seq: number;
  readonly kind: string;
  readonly ts: number;
  readonly data: Record<string, unknown>;
}

export interface LedgerEntry extends LedgerPayload {
  readonly prevSig: string;
  readonly sig: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Fixed genesis anchor — 64 hex zeros (256-bit worth of zeros). */
const GENESIS_PREV_SIG = "0".repeat(64);

/**
 * True for values `JSON.stringify` cannot represent: in an object it drops the
 * key, in an array it emits `null`. Canonicalisation must mirror this exactly,
 * or the signed form diverges from the stored (JSON.stringify'd) form and
 * `verify()` falsely reports tampering.
 */
function isJsonUnrepresentable(v: unknown): boolean {
  return v === undefined || typeof v === "function" || typeof v === "symbol";
}

/**
 * Produce a deterministic JSON string from a `LedgerPayload` by sorting keys
 * at every level. This is critical: `JSON.stringify` key order is insertion-
 * order-dependent; we need a stable canonical form for HMAC inputs.
 *
 * It must agree with `JSON.stringify` byte-for-byte on which fields exist,
 * because entries are persisted with `JSON.stringify` and re-canonicalised from
 * disk at verify time. In particular, object keys whose value is `undefined`
 * (or a function/symbol) are dropped, and such values inside arrays become
 * `null` — matching `JSON.stringify`.
 */
function canonicalise(value: unknown): string {
  if (isJsonUnrepresentable(value)) {
    // Reached only at the top level (object/array branches pre-filter); JSON
    // would yield `undefined` here, but a stable string keeps HMAC inputs sane.
    return "null";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return (
      "[" +
      value.map((v) => (isJsonUnrepresentable(v) ? "null" : canonicalise(v))).join(",") +
      "]"
    );
  }
  const obj = value as Record<string, unknown>;
  const sorted = Object.keys(obj)
    .filter((k) => !isJsonUnrepresentable(obj[k]))
    .sort()
    .map((k) => JSON.stringify(k) + ":" + canonicalise(obj[k]));
  return "{" + sorted.join(",") + "}";
}

/** Compute HMAC-SHA256 and return lowercase hex. */
function hmacSha256(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

/**
 * Scrub secret-shaped strings from ledger data so the signed Proof Receipt is
 * safe to share (ADR 0003). Shallow — ledger rows are flat key/value records.
 */
function redactData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = typeof v === "string" ? redact(v) : v;
  }
  return out;
}

/**
 * Sign an entry: HMAC over canonical(payload) + prevSig.
 * The payload fields included are the four LedgerPayload fields only —
 * prevSig and sig are NOT part of the signed payload to avoid circularity.
 */
function signEntry(
  secret: string,
  payload: LedgerPayload,
  prevSig: string,
): string {
  const canonical = canonicalise({
    data: payload.data,
    kind: payload.kind,
    seq: payload.seq,
    ts: payload.ts,
  });
  return hmacSha256(secret, canonical + prevSig);
}

async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

// ---------------------------------------------------------------------------
// Ledger class
// ---------------------------------------------------------------------------

export class Ledger {
  private readonly path: string;
  private readonly secret: string;
  private readonly now: () => number;
  /**
   * Serialise all writes through a promise chain so concurrent `append()`
   * calls never interleave their read-then-write sequences (same pattern as
   * FileExporter in src/telemetry/otel.ts).
   */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    path: string,
    secret: string,
    opts?: { readonly now?: () => number },
  ) {
    this.path = path;
    this.secret = secret;
    this.now = opts?.now ?? ((): number => Date.now());
  }

  /**
   * Append a new signed entry to the ledger and return it. Secret-shaped
   * strings in `data` are redacted before signing.
   *
   * The entry's `seq` is the current entry count (0-based), `prevSig` is the
   * signature of the immediately preceding entry (or GENESIS_PREV_SIG for the
   * first entry), and `sig` covers the canonical payload + prevSig.
   */
  append(kind: string, data: Record<string, unknown>): Promise<LedgerEntry> {
    let resolveEntry!: (entry: LedgerEntry) => void;
    let rejectEntry!: (err: unknown) => void;
    const entryPromise = new Promise<LedgerEntry>((res, rej) => {
      resolveEntry = res;
      rejectEntry = rej;
    });

    this.writeQueue = this.writeQueue.then(async (): Promise<void> => {
      try {
        await ensureParentDir(this.path);
        const prior = await this.readRaw();
        const seq = prior.length;
        const prevSig =
          seq === 0 ? GENESIS_PREV_SIG : (prior[seq - 1]?.sig ?? GENESIS_PREV_SIG);

        const payload: LedgerPayload = {
          seq,
          kind,
          ts: this.now(),
          data: redactData(data),
        };
        const sig = signEntry(this.secret, payload, prevSig);
        const entry: LedgerEntry = { ...payload, prevSig, sig };

        const existing = Bun.file(this.path);
        const priorText = (await existing.exists()) ? await existing.text() : "";
        await Bun.write(this.path, priorText + JSON.stringify(entry) + "\n");
        resolveEntry(entry);
      } catch (err: unknown) {
        rejectEntry(err);
      }
    });

    return entryPromise;
  }

  /**
   * Read and parse all entries from the JSONL file. Returns an empty array if
   * the file does not exist. Lines that cannot be parsed as JSON are skipped.
   */
  async readAll(): Promise<readonly LedgerEntry[]> {
    return this.readRaw();
  }

  /**
   * Verify the entire chain:
   * - Each entry's signature must match a fresh recomputation.
   * - Each entry's `prevSig` must match the preceding entry's `sig` (or
   *   GENESIS_PREV_SIG for seq 0).
   * - Each entry's `seq` must equal its index position.
   *
   * Returns `{ ok: true }` when the chain is intact, or
   * `{ ok: false, brokenAt: index, reason: string }` on the first violation.
   */
  async verify(): Promise<
    { ok: true } | { ok: false; brokenAt: number; reason: string }
  > {
    const entries = await this.readRaw();

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry === undefined) {
        return { ok: false, brokenAt: i, reason: "Entry is undefined" };
      }

      // 1. Sequence integrity
      if (entry.seq !== i) {
        return {
          ok: false,
          brokenAt: i,
          reason: `Expected seq ${i}, got ${entry.seq}`,
        };
      }

      // 2. prevSig link integrity
      const expectedPrevSig =
        i === 0 ? GENESIS_PREV_SIG : (entries[i - 1]?.sig ?? GENESIS_PREV_SIG);
      if (entry.prevSig !== expectedPrevSig) {
        return {
          ok: false,
          brokenAt: i,
          reason: `prevSig mismatch at seq ${i}`,
        };
      }

      // 3. HMAC signature integrity
      const payload: LedgerPayload = {
        seq: entry.seq,
        kind: entry.kind,
        ts: entry.ts,
        data: entry.data,
      };
      const expectedSig = signEntry(this.secret, payload, entry.prevSig);
      if (entry.sig !== expectedSig) {
        return {
          ok: false,
          brokenAt: i,
          reason: `Signature mismatch at seq ${i}`,
        };
      }
    }

    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private async readRaw(): Promise<LedgerEntry[]> {
    const file = Bun.file(this.path);
    if (!(await file.exists())) return [];
    const text = await file.text();
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    const entries: LedgerEntry[] = [];
    for (const line of lines) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (isLedgerEntry(parsed)) {
          entries.push(parsed);
        }
      } catch {
        // skip malformed lines
      }
    }
    return entries;
  }
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

function isLedgerEntry(v: unknown): v is LedgerEntry {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r["seq"] === "number" &&
    typeof r["kind"] === "string" &&
    typeof r["ts"] === "number" &&
    typeof r["data"] === "object" &&
    r["data"] !== null &&
    typeof r["prevSig"] === "string" &&
    typeof r["sig"] === "string"
  );
}
