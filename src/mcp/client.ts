/**
 * MCP JSON-RPC 2.0 client and stdio transport factory.
 *
 * ADR 0001 §7.6 (faithful MCP) + ADR 0003 (MCP output is untrusted).
 *
 * `McpClient` speaks the real MCP lifecycle: initialize → tools/list →
 * tools/call.  It correlates requests by auto-incrementing id and resolves
 * pending Promises on matching responses. All I/O is delegated to the
 * injected `McpTransport`, making the client fully unit-testable without a
 * real subprocess.
 *
 * `stdioTransport` wraps a Bun.spawn process; it is NOT exercised by unit
 * tests but is the production entry point.
 */

import type {
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  McpCallResult,
  McpContentItem,
  McpTool,
  McpTransport,
} from "./types.ts";
import { isJsonRpcError } from "./types.ts";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

/** Narrow an `unknown` frame to a typed JSON-RPC response, or return null. */
function parseResponse(json: string): JsonRpcResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("jsonrpc" in parsed) ||
    (parsed as Record<string, unknown>)["jsonrpc"] !== "2.0"
  ) {
    return null;
  }
  return parsed as JsonRpcResponse;
}

/** Flatten MCP content items to a single string. */
function flattenContent(items: readonly McpContentItem[]): string {
  return items
    .map((item) => (item.text ?? ""))
    .join("\n")
    .trimEnd();
}

// ---------------------------------------------------------------------------
// McpClient
// ---------------------------------------------------------------------------

export class McpClient {
  private readonly transport: McpTransport;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingCall>();

  constructor(transport: McpTransport) {
    this.transport = transport;
    this.transport.onMessage((json) => this.handleMessage(json));
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Send `initialize`, await the server's result, then confirm with `notifications/initialized`. */
  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "alfred", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
  }

  /** Fetch the list of tools the server exposes. */
  async listTools(): Promise<readonly McpTool[]> {
    const result = await this.request("tools/list");
    const raw = result as Record<string, unknown>;
    const tools = raw["tools"];
    if (!Array.isArray(tools)) {
      return [];
    }
    return tools.map((t): McpTool => {
      const tool = t as Record<string, unknown>;
      return {
        name: String(tool["name"] ?? ""),
        description: typeof tool["description"] === "string" ? tool["description"] : undefined,
        inputSchema:
          typeof tool["inputSchema"] === "object" && tool["inputSchema"] !== null
            ? (tool["inputSchema"] as Record<string, unknown>)
            : {},
      };
    });
  }

  /**
   * Invoke a remote tool and return a flat text representation plus an error
   * flag. ADR 0003: callers MUST treat this content as untrusted.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ readonly text: string; readonly isError: boolean }> {
    const result = await this.request("tools/call", { name, arguments: args });
    const raw = result as Record<string, unknown>;

    const isError = raw["isError"] === true;
    const contentRaw = raw["content"];
    const content: readonly McpContentItem[] = Array.isArray(contentRaw)
      ? (contentRaw as McpContentItem[])
      : [];

    return { text: flattenContent(content), isError };
  }

  /** Tear down the underlying transport. */
  close(): void {
    this.transport.close();
  }

  // -------------------------------------------------------------------------
  // Internal request / response correlation
  // -------------------------------------------------------------------------

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const id = this.nextId++;
      const message: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      };
      this.pending.set(id, { resolve, reject });
      this.transport.send(JSON.stringify(message));
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    const message: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.transport.send(JSON.stringify(message));
  }

  private handleMessage(json: string): void {
    const response = parseResponse(json);
    if (response === null) return;

    const id = (response as { id: JsonRpcId | null }).id;
    if (id === null || id === undefined) return;

    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);

    if (isJsonRpcError(response)) {
      const { code, message } = response.error;
      pending.reject(new Error(`MCP JSON-RPC error ${code}: ${message}`));
    } else {
      pending.resolve(response.result);
    }
  }
}

// ---------------------------------------------------------------------------
// stdioTransport — production transport (Bun.spawn, not exercised by unit tests)
// ---------------------------------------------------------------------------

/**
 * Bun.spawn-backed transport for a real MCP server process.
 * Messages are newline-delimited JSON on the process's stdin/stdout.
 */
export function stdioTransport(
  command: string,
  args: readonly string[] = [],
): McpTransport {
  const proc = Bun.spawn([command, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });

  const listeners: Array<(json: string) => void> = [];
  let buffer = "";

  // Read stdout line by line in the background.
  (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          for (const cb of listeners) {
            cb(trimmed);
          }
        }
      }
    }
  })();

  return {
    send(json: string): void {
      proc.stdin.write(json + "\n");
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
