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
  readonly contents: string | { readonly value: string } | ReadonlyArray<{ readonly value: string }>;
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

/**
 * Return a stateful chunk consumer that calls `onMessage` exactly once for
 * each complete LSP Content-Length-framed message, even if the message
 * arrives split across multiple chunks.
 *
 * The returned function may be called with any number of raw string chunks in
 * any order; it buffers internally and is safe to call sequentially.
 */
export function createFrameParser(onMessage: (json: string) => void): (chunk: string) => void {
  let buffer = "";

  return function consumeChunk(chunk: string): void {
    buffer += chunk;

    // Keep consuming complete frames from the front of the buffer.
    while (true) {
      const sepIdx = buffer.indexOf(HEADER_SEP);
      if (sepIdx === -1) break; // header not yet complete

      const headerSection = buffer.slice(0, sepIdx);
      const match = CONTENT_LENGTH_RE.exec(headerSection);
      if (match === null) {
        // Malformed header — discard up to and including the separator.
        buffer = buffer.slice(sepIdx + HEADER_SEP.length);
        continue;
      }

      const contentLength = parseInt(match[1] ?? "0", 10);
      const bodyStart = sepIdx + HEADER_SEP.length;
      const bodyEnd = bodyStart + contentLength;

      if (buffer.length < bodyEnd) break; // body not yet complete

      const body = buffer.slice(bodyStart, bodyEnd);
      buffer = buffer.slice(bodyEnd);
      onMessage(body);
    }
  };
}
