/**
 * LSP wire types and Content-Length framing utilities.
 *
 * ADR 0002 (LSP client — IDE-grade code intelligence).
 *
 * This module owns:
 *   - LSP domain types used across the LSP sub-package
 *   - `encodeMessage` — wrap a JSON object in LSP Content-Length framing
 *   - `createFrameParser` — streaming parser that reassembles framed messages
 *     across arbitrary chunk boundaries (pure, unit-testable, no I/O)
 *
 * The real stdio transport consumes these helpers; unit tests never need a
 * live language server — they feed strings directly to the parser.
 */

// ---------------------------------------------------------------------------
// LSP domain types
// ---------------------------------------------------------------------------

export interface Position {
  readonly line: number;
  readonly character: number;
}

export interface Range {
  readonly start: Position;
  readonly end: Position;
}

export interface Location {
  readonly uri: string;
  readonly range: Range;
}

export interface Hover {
  readonly contents:
    | string
    | { readonly value: string }
    | ReadonlyArray<{ readonly value: string }>;
}

export type DiagnosticSeverity = 1 | 2 | 3 | 4; // Error | Warning | Information | Hint

export interface Diagnostic {
  readonly range: Range;
  readonly severity?: DiagnosticSeverity;
  readonly message: string;
  readonly source?: string;
}

// ---------------------------------------------------------------------------
// Transport abstraction
// ---------------------------------------------------------------------------

/**
 * Injectable transport for the LSP client.  Concrete implementations:
 *   - `stdioTransport` (Bun.spawn + Content-Length framing over stdio)
 *   - In-memory fakes used in unit tests
 *
 * The transport delivers one complete JSON payload per `onMessage` call.
 */
export interface LspTransport {
  /** Write one complete JSON-RPC payload (framing is the transport's job). */
  send(json: string): void;
  /** Register a listener; called once per complete inbound JSON payload. */
  onMessage(cb: (json: string) => void): void;
  /** Tear down the underlying connection / subprocess. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Content-Length framing
// ---------------------------------------------------------------------------

const HEADER_SEP = "\r\n\r\n";
const CONTENT_LENGTH_RE = /Content-Length:\s*(\d+)/i;

/**
 * Wrap `obj` in an LSP Content-Length frame.
 *
 * Format: `Content-Length: N\r\n\r\n<json>`
 */
export function encodeMessage(obj: unknown): string {
  const body = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}${HEADER_SEP}${body}`;
}

/** Index of the first occurrence of byte sequence `needle` in `hay`, or -1. */
function indexOfBytes(hay: Uint8Array, needle: Uint8Array): number {
  const last = hay.length - needle.length;
  outer: for (let i = 0; i <= last; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Return a stateful chunk consumer that calls `onMessage` exactly once for
 * each complete LSP Content-Length-framed message, even if the message
 * arrives split across multiple chunks.
 *
 * The returned function accepts either decoded strings (convenient for unit
 * tests) or raw `Uint8Array` chunks (what the stdio transport reads). Framing
 * is computed on BYTES, not characters: `Content-Length` is a UTF-8 byte count
 * per the LSP spec, so slicing a decoded JS string by that number would
 * over-read on any multi-byte content (e.g. non-ASCII identifiers, emoji) and
 * desynchronise every subsequent frame. Buffering raw bytes and decoding only
 * complete frame bodies keeps the parser correct for all UTF-8 input.
 *
 * It buffers internally and is safe to call sequentially with any chunking.
 */
export function createFrameParser(
  onMessage: (json: string) => void,
): (chunk: string | Uint8Array) => void {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const separator = encoder.encode(HEADER_SEP);
  // Widened element type: appended chunks may be backed by ArrayBuffer or a
  // SharedArrayBuffer, and `new Uint8Array(n)` is ArrayBuffer-backed — both
  // unify under the default `ArrayBufferLike` parameter.
  let buffer: Uint8Array = new Uint8Array(0);

  function append(bytes: Uint8Array): void {
    if (buffer.length === 0) {
      buffer = bytes;
      return;
    }
    const merged = new Uint8Array(buffer.length + bytes.length);
    merged.set(buffer);
    merged.set(bytes, buffer.length);
    buffer = merged;
  }

  return function consumeChunk(chunk: string | Uint8Array): void {
    append(typeof chunk === "string" ? encoder.encode(chunk) : chunk);

    // Keep consuming complete frames from the front of the buffer.
    while (true) {
      const sepIdx = indexOfBytes(buffer, separator);
      if (sepIdx === -1) break; // header not yet complete

      const headerSection = decoder.decode(buffer.subarray(0, sepIdx));
      const match = CONTENT_LENGTH_RE.exec(headerSection);
      if (match === null) {
        // Malformed header or non-LSP preamble (e.g. a launcher banner) —
        // discard up to and including the separator and resynchronise.
        buffer = buffer.slice(sepIdx + separator.length);
        continue;
      }

      const contentLength = parseInt(match[1] ?? "0", 10);
      const bodyStart = sepIdx + separator.length;
      const bodyEnd = bodyStart + contentLength; // byte offsets, per the spec

      if (buffer.length < bodyEnd) break; // body not yet complete

      const body = decoder.decode(buffer.subarray(bodyStart, bodyEnd));
      buffer = buffer.slice(bodyEnd);
      onMessage(body);
    }
  };
}
