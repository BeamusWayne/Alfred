import { z } from "zod";
import { buildTool } from "./types.js";
import type { ToolUseContext, ToolResult } from "./types.js";

const inputSchema = z.object({
  query: z.string().describe("The search query"),
  numResults: z.number().optional().describe("Number of results (default: 5)"),
});

export const webSearchTool = buildTool({
  name: "web_search",
  description: "Search the web for information",
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  call: async (input, _context): Promise<ToolResult<string>> => {
    return {
      content: `Web search for "${input.query}" requires a search API integration (e.g., Google, Bing, Brave). Configure a search provider to enable this tool.`,
    };
  },
});
