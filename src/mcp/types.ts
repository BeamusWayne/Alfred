import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { buildTool } from "../tools/types.js";
import type { Tool as AlfredTool, ToolUseContext, ToolResult } from "../tools/types.js";

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpConnection {
  name: string;
  client: Client;
  tools: AlfredTool[];
}

export async function connectMcpServer(config: McpServerConfig): Promise<McpConnection> {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: config.env ? { ...process.env, ...config.env } as Record<string, string> : undefined,
  });

  const client = new Client(
    { name: "alfred-cli", version: "0.1.0" },
    { capabilities: {} },
  );

  await client.connect(transport);

  const { tools: mcpTools } = await client.listTools();

  const alfredTools: AlfredTool[] = (mcpTools ?? []).map((mcpTool) => {
    const toolName = `${config.name}__${mcpTool.name}`;
    return buildTool({
      name: toolName,
      description: mcpTool.description ?? `MCP tool: ${mcpTool.name}`,
      inputSchema: z.object({}).passthrough(),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: async (input: Record<string, unknown>, _context: ToolUseContext): Promise<ToolResult<string>> => {
        try {
          const result = await client.callTool({
            name: mcpTool.name,
            arguments: input,
          });

          const content = Array.isArray(result.content)
            ? result.content.map((c) => {
                if (typeof c === "object" && "text" in c) return (c as { text: string }).text;
                return JSON.stringify(c);
              }).join("\n")
            : JSON.stringify(result.content);

          return { content };
        } catch (err) {
          return {
            content: `MCP tool error: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    });
  });

  return { name: config.name, client, tools: alfredTools };
}

export async function disconnectMcpServer(connection: McpConnection): Promise<void> {
  await connection.client.close();
}
