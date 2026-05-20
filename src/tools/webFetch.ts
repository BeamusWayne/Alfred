import { z } from "zod";
import { buildTool } from "./types.js";
import type { ToolUseContext, ToolResult } from "./types.js";

const inputSchema = z.object({
  url: z.string().describe("The URL to fetch"),
  maxCharacters: z.number().optional().describe("Max characters to return (default: 10000)"),
});

export const webFetchTool = buildTool({
  name: "web_fetch",
  description: "Fetch the content of a URL and return it as text",
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  call: async (input, _context): Promise<ToolResult<string>> => {
    const maxChars = input.maxCharacters ?? 10000;
    try {
      const response = await fetch(input.url, {
        signal: AbortSignal.timeout(30000),
        headers: { "User-Agent": "Alfred-CLI/0.1.0" },
      });

      if (!response.ok) {
        return { content: `HTTP ${response.status} ${response.statusText}`, isError: true };
      }

      const contentType = response.headers.get("content-type") ?? "";
      const text = await response.text();

      const cleaned = contentType.includes("html")
        ? text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
        : text;

      return {
        content: cleaned.length > maxChars
          ? cleaned.substring(0, maxChars) + "\n... (truncated)"
          : cleaned,
      };
    } catch (err) {
      return {
        content: `Error fetching URL: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
});
