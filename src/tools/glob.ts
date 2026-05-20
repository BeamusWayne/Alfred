import { z } from "zod";
import { buildTool } from "./types.js";
import type { ToolUseContext, ToolResult } from "./types.js";
import { glob as globAsync } from "fs/promises";

const inputSchema = z.object({
  pattern: z.string().describe("Glob pattern to match (e.g., '**/*.ts')"),
  cwd: z.string().optional().describe("Base directory for the search"),
});

export const globTool = buildTool({
  name: "glob",
  description: "Find files matching a glob pattern",
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  call: async (input, context): Promise<ToolResult<string>> => {
    const cwd = input.cwd ?? context.workingDir;

    try {
      const matches: string[] = [];
      for await (const entry of globAsync(input.pattern, { cwd })) {
        matches.push(entry);
      }

      if (matches.length === 0) {
        return { content: "No files matched the pattern" };
      }

      return { content: matches.join("\n") };
    } catch (err) {
      return {
        content: `Error searching files: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
});
