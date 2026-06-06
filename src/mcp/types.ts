/**
 * MCP JSON-RPC 2.0 wire types and transport abstraction.
 *
 * ADR 0001 §7.6 (faithful MCP) + ADR 0003 (MCP output is untrusted).
 *
 * This module owns only the protocol surface: JSON-RPC envelopes and the
 * injectable `McpTransport` interface. No I/O happens here, keeping this
 * module easy to test with in-memory fakes.
 */

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 primitives
// ---------------------------------------------------------------------------

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface JsonRpcSuccess<T = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: T;
}

export interface JsonRpcError {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export type JsonRpcResponse<T = unknown> = JsonRpcSuccess<T> | JsonRpcError;

export function isJsonRpcError(r: JsonRpcResponse): r is JsonRpcError {
  return "error" in r;
}

// ---------------------------------------------------------------------------
// MCP domain types
// ---------------------------------------------------------------------------

/** A tool advertised by a remote MCP server. */
export interface McpTool {
  readonly name: string;
  readonly description?: string;
  /** Raw JSON Schema for the tool's input (passed through, not validated here). */
  readonly inputSchema: Record<string, unknown>;
}

/** Content item returned inside a `tools/call` response. */
export interface McpContentItem {
  readonly type: string;
  readonly text?: string;
}

/** Raw result payload for a `tools/call` response. */
export interface McpCallResult {
  readonly content: readonly McpContentItem[];
  readonly isError?: boolean;
}

// ---------------------------------------------------------------------------
// Transport abstraction
// ---------------------------------------------------------------------------

/**
 * Injectable transport interface. Concrete implementations include:
 *   - `stdioTransport` (Bun.spawn newline-delimited JSON over stdio)
 *   - In-memory fakes used in unit tests
 *
 * The transport deals only with raw string frames. Framing, correlation, and
 * promise management are the client's responsibility.
 */
export interface McpTransport {
  /** Write one complete JSON-RPC message (caller adds the newline if needed). */
  send(json: string): void;
  /** Register a listener; called once per complete inbound JSON frame. */
  onMessage(cb: (json: string) => void): void;
  /** Tear down the underlying connection / subprocess. */
  close(): void;
}
