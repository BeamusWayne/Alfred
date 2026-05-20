import { z } from "zod";
import { buildTool } from "./types.js";
import type { ToolUseContext, ToolResult } from "./types.js";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import * as path from "path";

const inputSchema = z.object({
  path: z.string().describe("Absolute or relative path to the file"),
  offset: z.number().optional().describe("Line number to start reading from (0-indexed)"),
  limit: z.number().optional().describe("Maximum number of lines to read"),
});

export const fileReadTool = buildTool({
  name: "file_read",
  description: "Read the contents of a file",
  inputSchema,
  aliases: ["read"],
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  call: async (input, context): Promise<ToolResult<string>> => {
    const filePath = path.resolve(context.workingDir, input.path);

    if (!existsSync(filePath)) {
      return { content: `File not found: ${input.path}`, isError: true };
    }

    try {
      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n");

      const start = input.offset ?? 0;
      const end = input.limit ? start + input.limit : lines.length;
      const selectedLines = lines.slice(start, end);

      const numberedLines = selectedLines
        .map((line, i) => `${start + i + 1}\t${line}`)
        .join("\n");

      context.readFileState.set(filePath, content);
      return { content: numberedLines };
    } catch (err) {
      return {
        content: `Error reading file: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
});
