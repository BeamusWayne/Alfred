/**
 * LSP JSON-RPC 2.0 client and stdio transport factory.
 *
 * ADR 0002 (LSP client — IDE-grade code intelligence).
 *
 * `LspClient` speaks the LSP lifecycle over an injected `LspTransport`:
 *   initialize → didOpen → definition / references / hover / diagnostics → shutdown.
 *
 * Request-id correlation mirrors `McpClient` (src/mcp/client.ts): each request
 * gets an auto-incrementing integer id; responses resolve the matching Promise.
 * Notifications (e.g. `textDocument/publishDiagnostics`) are dispatched to
 * registered handlers without needing a matching request.
 *
 * `stdioTransport` wraps a Bun.spawn process using the Content-Length framer
 * from `./protocol.ts`. It is NOT exercised by unit tests.
 */

import {
  encodeMessage,
  createFrameParser,
} from "./protocol.ts";
import type {
  Diagnostic,
  Hover,
  Location,
  Position,
  LspTransport,
} from "./protocol.ts";

// ---------------------------------------------------------------------------
// Re-export protocol types so callers import from one place
// ---------------------------------------------------------------------------

export type { Diagnostic, Hover, Location, Position, LspTransport } from "./protocol.ts";
export { encodeMessage, createFrameParser } from "./protocol.ts";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type JsonRpcId = number;

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

interface JsonRpcFrame {
  readonly jsonrpc: "2.0";
  readonly id?: JsonRpcId;
  readonly method?: string;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
  readonly params?: unknown;
}

function parseFrame(json: string): JsonRpcFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const frame = parsed as Record<string, unknown>;
  if (frame["jsonrpc"] !== "2.0") return null;
  return parsed as JsonRpcFrame;
}

/** Extract `Location[]` from an LSP definition/references result payload. */
function toLocations(raw: unknown): readonly Location[] {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) {
    return (raw as unknown[]).flatMap((item): Location[] => {
      const loc = item as Record<string, unknown>;
      if (typeof loc["uri"] !== "string") return [];
      const range = loc["range"] as Record<string, unknown> | undefined;
      if (!range) return [];
      const start = range["start"] as Record<string, unknown> | undefined;
      const end = range["end"] as Record<string, unknown> | undefined;
      if (!start || !end) return [];
      return [
        {
          uri: loc["uri"] as string,
          range: {
            start: { line: Number(start["line"]), character: Number(start["character"]) },
            end: { line: Number(end["line"]), character: Number(end["character"]) },
          },
        },
      ];
    });
  }
  // Single Location object (not an array)
  const loc = raw as Record<string, unknown>;
  if (typeof loc["uri"] !== "string") return [];
  return toLocations([raw]);
}

/** Extract displayable text from an LSP Hover result. */
function extractHoverText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const hover = raw as Record<string, unknown>;
  const contents = hover["contents"];
  if (contents === null || contents === undefined) return null;
  if (typeof contents === "string") return contents || null;
  if (typeof contents === "object") {
    if (Array.isArray(contents)) {
      const parts = (contents as unknown[])
        .map((c) => {
          if (typeof c === "string") return c;
          const obj = c as Record<string, unknown>;
          return typeof obj["value"] === "string" ? obj["value"] : "";
        })
        .filter(Boolean);
      return parts.join("\n") || null;
    }
    const obj = contents as Record<string, unknown>;
    if (typeof obj["value"] === "string") return obj["value"] || null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// LspClient
// ---------------------------------------------------------------------------

export class LspClient {
  private readonly transport: LspTransport;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingCall>();
  /** uri → latest diagnostics list from publishDiagnostics notifications */
  private readonly diagCache = new Map<string, readonly Diagnostic[]>();

  constructor(transport: LspTransport) {
    this.transport = transport;
    this.transport.onMessage((json) => this.handleMessage(json));
  }

  // -------------------------------------------------------------------------
  // Public lifecycle API
  // -------------------------------------------------------------------------

  /**
   * Send LSP `initialize` with the project root, then confirm with
   * `initialized` notification. Must be called before any other method.
   */
  async initialize(rootUri: string): Promise<void> {
    await this.request("initialize", {
      processId: null,
      rootUri,
      capabilities: {
        textDocument: {
          definition: { linkSupport: false },
          references: {},
          hover: { contentFormat: ["plaintext", "markdown"] },
          publishDiagnostics: {},
        },
      },
      clientInfo: { name: "alfred-lsp", version: "0.1.0" },
    });
    this.notify("initialized", {});
  }

  /**
   * Notify the server that a file has been opened (required before querying
   * definition/references/hover on that file).
   */
  didOpen(uri: string, languageId: string, text: string): void {
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
  }

  /** Resolve the definition location(s) for the symbol at `pos`. */
  async definition(uri: string, pos: Position): Promise<readonly Location[]> {
    const result = await this.request("textDocument/definition", {
      textDocument: { uri },
      position: pos,
    });
    return toLocations(result);
  }

  /** Find all references to the symbol at `pos`. */
  async references(uri: string, pos: Position): Promise<readonly Location[]> {
    const result = await this.request("textDocument/references", {
      textDocument: { uri },
      position: pos,
      context: { includeDeclaration: true },
    });
    return toLocations(result);
  }

  /**
   * Retrieve hover information for the symbol at `pos`.
   * Returns the displayable text, or `null` if the server has nothing to say.
   */
  async hover(uri: string, pos: Position): Promise<string | null> {
    const result = await this.request("textDocument/hover", {
      textDocument: { uri },
      position: pos,
    });
    return extractHoverText(result);
  }

  /**
   * Return the latest diagnostics for `uri` as captured from
   * `textDocument/publishDiagnostics` notifications. Never triggers a request;
   * returns an empty array if no notification has arrived yet.
   */
  diagnostics(uri: string): readonly Diagnostic[] {
    return this.diagCache.get(uri) ?? [];
  }

  /** Gracefully shut down the server then close the transport. */
  async shutdown(): Promise<void> {
    await this.request("shutdown");
    this.notify("exit", {});
    this.transport.close();
  }

  // -------------------------------------------------------------------------
  // Internal request / response / notification correlation
  // -------------------------------------------------------------------------

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const id = this.nextId++;
      const message = {
        jsonrpc: "2.0" as const,
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      };
      this.pending.set(id, { resolve, reject });
      this.transport.send(JSON.stringify(message));
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    const message = { jsonrpc: "2.0" as const, method, params };
    this.transport.send(JSON.stringify(message));
  }

  private handleMessage(json: string): void {
    const frame = parseFrame(json);
    if (frame === null) return;

    // Notification from server (no id, has method)
    if (frame.id === undefined && typeof frame.method === "string") {
      this.handleNotification(frame.method, frame.params);
      return;
    }

    // Response (has id)
    if (frame.id !== undefined) {
      const pending = this.pending.get(frame.id);
      if (pending === undefined) return;
      this.pending.delete(frame.id);

      if (frame.error !== undefined) {
        pending.reject(
          new Error(`LSP JSON-RPC error ${frame.error.code}: ${frame.error.message}`),
        );
      } else {
        pending.resolve(frame.result);
      }
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "textDocument/publishDiagnostics") {
      const p = params as Record<string, unknown>;
      const uri = typeof p["uri"] === "string" ? p["uri"] : null;
      if (uri === null) return;

      const rawDiags = Array.isArray(p["diagnostics"]) ? (p["diagnostics"] as unknown[]) : [];
      const diags: readonly Diagnostic[] = rawDiags.flatMap((d): Diagnostic[] => {
        const diag = d as Record<string, unknown>;
        const range = diag["range"] as Record<string, unknown> | undefined;
        if (!range) return [];
        const start = range["start"] as Record<string, unknown> | undefined;
        const end = range["end"] as Record<string, unknown> | undefined;
        if (!start || !end) return [];
        return [
          {
            range: {
              start: { line: Number(start["line"]), character: Number(start["character"]) },
              end: { line: Number(end["line"]), character: Number(end["character"]) },
            },
            severity: typeof diag["severity"] === "number"
              ? (diag["severity"] as 1 | 2 | 3 | 4)
              : undefined,
            message: typeof diag["message"] === "string" ? diag["message"] : "",
            source: typeof diag["source"] === "string" ? diag["source"] : undefined,
          },
        ];
      });
      this.diagCache.set(uri, diags);
    }
  }
}

// ---------------------------------------------------------------------------
// stdioTransport — production transport (Bun.spawn, not exercised by unit tests)
// ---------------------------------------------------------------------------

/**
 * Bun.spawn-backed transport for a real language server process.
 * Messages use LSP Content-Length framing on stdin/stdout.
 */
export function stdioTransport(
  command: string,
  args: readonly string[] = [],
): LspTransport {
  const proc = Bun.spawn([command, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });

  const listeners: Array<(json: string) => void> = [];
  const parser = createFrameParser((json) => {
    for (const cb of listeners) {
      cb(json);
    }
  });

  // Pump stdout through the frame parser in the background.
  (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parser(decoder.decode(value, { stream: true }));
    }
  })();

  return {
    send(json: string): void {
      proc.stdin.write(encodeMessage(JSON.parse(json)));
    },
    onMessage(cb: (json: string) => void): void {
      listeners.push(cb);
    },
    close(): void {
      proc.stdin.end();
      proc.kill();
    },
  };
}
