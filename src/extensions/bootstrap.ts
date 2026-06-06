/**
 * Startup bootstrap for MCP + LSP extension servers.
 *
 * ADR 0001 §7.6 (faithful MCP) + ADR 0002 (LSP).
 *
 * Reads optional config files from `.alfred/mcp.json` and `.alfred/lsp.json`,
 * connects each declared server, and returns the union of all resulting Alfred
 * tools plus a `close()` handle that shuts every transport down cleanly.
 *
 * Missing or malformed config files are silently skipped — the function never
 * throws due to absent config.  A failure connecting an individual server is
 * caught and skipped rather than aborting the whole bootstrap.
 */

import { z } from "zod";
import { McpClient, stdioTransport as mcpStdioTransport } from "../mcp/client.ts";
import { mcpToolToAlfredTool } from "../mcp/toolAdapter.ts";
import { LspClient, stdioTransport as lspStdioTransport } from "../tools/lsp/client.ts";
import { makeLspTools } from "../tools/lsp/tools.ts";
import type { Tool } from "../tools/types.ts";
import type { McpTransport } from "../mcp/types.ts";
import type { LspTransport } from "../tools/lsp/client.ts";

/**
 * Default per-server connect/request timeout. Generous enough for a cold
 * `tsserver` start, short enough that a dead server fails fast instead of
 * stalling startup forever.
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Config schemas
// ---------------------------------------------------------------------------

const mcpServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
});

export const mcpConfigSchema = z.object({
  servers: z.array(mcpServerSchema).default([]),
});

const lspServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  rootUri: z.string().optional(),
});

export const lspConfigSchema = z.object({
  servers: z.array(lspServerSchema).default([]),
});

export type McpConfig = z.output<typeof mcpConfigSchema>;
export type LspConfig = z.output<typeof lspConfigSchema>;

// ---------------------------------------------------------------------------
// Config loaders (exported for testability)
// ---------------------------------------------------------------------------

/** Read and validate `.alfred/mcp.json`. Missing or invalid → `{ servers: [] }`. */
export async function loadMcpConfig(filePath: string): Promise<McpConfig> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return { servers: [] };
  }
  let raw: unknown;
  try {
    raw = await file.json();
  } catch {
    return { servers: [] };
  }
  const parsed = mcpConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return { servers: [] };
  }
  return parsed.data;
}

/** Read and validate `.alfred/lsp.json`. Missing or invalid → `{ servers: [] }`. */
export async function loadLspConfig(filePath: string): Promise<LspConfig> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return { servers: [] };
  }
  let raw: unknown;
  try {
    raw = await file.json();
  } catch {
    return { servers: [] };
  }
  const parsed = lspConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return { servers: [] };
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// MCP tool builder (exported for testability)
// ---------------------------------------------------------------------------

/**
 * Given an already-connected and initialized `McpClient`, fetch its tool list
 * and adapt every entry to an Alfred `Tool`.
 */
export async function buildMcpTools(client: McpClient): Promise<readonly Tool[]> {
  const mcpTools = await client.listTools();
  return mcpTools.map((tool) => mcpToolToAlfredTool(client, tool));
}

// ---------------------------------------------------------------------------
// Bootstrap result
// ---------------------------------------------------------------------------

export interface BootstrapResult {
  readonly tools: readonly Tool[];
  readonly close: () => Promise<void>;
  /**
   * One human-readable line per server that failed to connect. Empty when
   * every configured server connected (or none were configured). Surfacing
   * these is what makes a launch failure diagnosable instead of a silent
   * "no tools appeared".
   */
  readonly warnings: readonly string[];
}

export interface BootstrapOptions {
  /**
   * Called once per server that fails to connect, with a ready-to-print
   * message. Use it to stream warnings to stderr at startup. The same messages
   * are also collected in `BootstrapResult.warnings`.
   */
  readonly onWarn?: (message: string) => void;
  /**
   * Per-server connect/request timeout in milliseconds.
   * Defaults to {@link DEFAULT_CONNECT_TIMEOUT_MS}.
   */
  readonly connectTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Connect all MCP and LSP servers declared in `.alfred/mcp.json` and
 * `.alfred/lsp.json` inside `workingDir`, then return the combined tool set
 * plus a `close()` that tears every connection down.
 *
 * - Missing config files → silently skipped.
 * - Malformed config → silently skipped.
 * - Individual server connection failures → caught + skipped, not fatal.
 * - If no config files exist, returns `{ tools: [], close }` immediately.
 */
export async function bootstrapExtensions(
  workingDir: string,
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const mcpConfigPath = `${workingDir}/.alfred/mcp.json`;
  const lspConfigPath = `${workingDir}/.alfred/lsp.json`;
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  const [mcpConfig, lspConfig] = await Promise.all([
    loadMcpConfig(mcpConfigPath),
    loadLspConfig(lspConfigPath),
  ]);

  const allTools: Tool[] = [];
  const closers: Array<() => Promise<void> | void> = [];
  const warnings: string[] = [];

  const warn = (message: string): void => {
    warnings.push(message);
    options.onWarn?.(message);
  };

  const label = (kind: string, command: string, args: readonly string[] | undefined): string =>
    `${kind} server "${command}${args && args.length > 0 ? " " + args.join(" ") : ""}"`;

  // ---- MCP servers ----
  for (const server of mcpConfig.servers) {
    const name = label("MCP", server.command, server.args);
    let transport: McpTransport | undefined;
    try {
      transport = mcpStdioTransport(server.command, server.args ?? []);
      const client = new McpClient(transport, { requestTimeoutMs: timeoutMs });
      await client.initialize();
      const tools = await buildMcpTools(client);
      for (const tool of tools) {
        allTools.push(tool);
      }
      closers.push(() => client.close());
    } catch (err) {
      // Non-fatal, but never silent: report why the server was skipped and tear
      // down any process that did manage to spawn so it doesn't leak.
      warn(`${name} failed to connect: ${errMessage(err)}`);
      try {
        transport?.close();
      } catch {
        // already gone
      }
    }
  }

  // ---- LSP servers ----
  for (const server of lspConfig.servers) {
    const name = label("LSP", server.command, server.args);
    let transport: LspTransport | undefined;
    try {
      transport = lspStdioTransport(server.command, server.args ?? []);
      const client = new LspClient(transport, { requestTimeoutMs: timeoutMs });
      const rootUri = server.rootUri ?? `file://${workingDir}`;
      await client.initialize(rootUri);
      const tools = makeLspTools(client);
      for (const tool of tools) {
        allTools.push(tool);
      }
      closers.push(async () => {
        try {
          await client.shutdown();
        } catch {
          // Ignore shutdown errors — the process may have already exited.
        }
      });
    } catch (err) {
      warn(`${name} failed to connect: ${errMessage(err)}`);
      try {
        transport?.close();
      } catch {
        // already gone
      }
    }
  }

  const close = async (): Promise<void> => {
    await Promise.all(closers.map((fn) => fn()));
  };

  return { tools: allTools, close, warnings };
}
