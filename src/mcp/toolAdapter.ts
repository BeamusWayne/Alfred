/**
 * Adapts remote MCP tools into Alfred `Tool` instances.
 *
 * ADR 0001 §7.6 (faithful MCP) + ADR 0003 (MCP output is untrusted).
 *
 * Each adapted tool:
 *   - Is named `mcp__<original-name>` to avoid collisions.
 *   - Uses a permissive Zod schema (`z.record(z.string(), z.unknown())`) for
 *     input; the real JSON Schema is embedded in the description and passed
 *     through to the model verbatim.
 *   - Sets `untrusted: true` on every result so the engine fences it
 *     (ADR 0003).
 *   - Defers permission to `ask()` — the user must approve each MCP call.
 */

import { z } from "zod";
import { ask } from "../permissions/types.ts";
import type { Tool, ToolResult } from "../tools/types.ts";
import { buildTool } from "../tools/types.ts";
import type { McpClient } from "./client.ts";
import type { McpTool } from "./types.ts";

/** Permissive input schema accepted by all adapted MCP tools. */
const mcpInputSchema = z.record(z.string(), z.unknown());
type McpInput = z.output<typeof mcpInputSchema>;

/**
 * Convert one `McpTool` + a live `McpClient` into an Alfred `Tool`.
 *
 * The produced tool's name is prefixed with `mcp__` to make its origin
 * unambiguous in logs, transcripts, and permission prompts.
 */
export function mcpToolToAlfredTool(client: McpClient, tool: McpTool): Tool {
  const alfredName = `mcp__${tool.name}`;

  const schemaNote =
    Object.keys(tool.inputSchema).length > 0
      ? `\n\nInput schema (JSON Schema): ${JSON.stringify(tool.inputSchema)}`
      : "";

  const description = `${tool.description ?? tool.name}${schemaNote}`;

  return buildTool<typeof mcpInputSchema, string>({
    name: alfredName,
    description,
    inputSchema: mcpInputSchema,

    isReadOnly: () => false,
    isConcurrencySafe: () => false,

    checkPermissions: async (_input, _ctx) => ask(`Allow MCP tool call: ${alfredName}?`),

    describeCall: (input: McpInput) => `${alfredName}(${JSON.stringify(input)})`,

    call: async (input: McpInput): Promise<ToolResult<string>> => {
      const { text, isError } = await client.callTool(tool.name, input);
      return {
        content: text,
        isError,
        untrusted: true, // ADR 0003: MCP content is never trusted
      };
    },
  });
}
