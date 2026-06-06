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
export async function bootstrapExtensions(workingDir: string): Promise<BootstrapResult> {
  const mcpConfigPath = `${workingDir}/.alfred/mcp.json`;
  const lspConfigPath = `${workingDir}/.alfred/lsp.json`;

  const [mcpConfig, lspConfig] = await Promise.all([
    loadMcpConfig(mcpConfigPath),
    loadLspConfig(lspConfigPath),
  ]);

  const allTools: Tool[] = [];
  const closers: Array<() => Promise<void> | void> = [];

  // ---- MCP servers ----
  for (const server of mcpConfig.servers) {
    try {
      const transport = mcpStdioTransport(server.command, server.args ?? []);
      const client = new McpClient(transport);
      await client.initialize();
      const tools = await buildMcpTools(client);
      for (const tool of tools) {
        allTools.push(tool);
      }
      closers.push(() => client.close());
    } catch {
      // Individual server failures are non-fatal; skip this server.
    }
  }

  // ---- LSP servers ----
  for (const server of lspConfig.servers) {
    try {
      const transport = lspStdioTransport(server.command, server.args ?? []);
      const client = new LspClient(transport);
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
    } catch {
      // Individual server failures are non-fatal; skip this server.
    }
  }

  const close = async (): Promise<void> => {
    await Promise.all(closers.map((fn) => fn()));
  };

  return { tools: allTools, close };
}
