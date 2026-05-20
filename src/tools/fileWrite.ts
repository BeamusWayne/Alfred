import { z } from "zod";
import { buildTool } from "./types.js";
import type { ToolUseContext, ToolResult } from "./types.js";
import { writeFile, mkdir } from "fs/promises";
import * as path from "path";

const inputSchema = z.object({
  path: z.string().describe("Absolute or relative path to write to"),
  content: z.string().describe("The content to write"),
});

export const fileWriteTool = buildTool({
  name: "file_write",
  description: "Create or overwrite a file with the given content",
  inputSchema,
  aliases: ["write"],
  isDestructive: () => true,
  call: async (input, context): Promise<ToolResult<string>> => {
    const filePath = path.resolve(context.workingDir, input.path);

    try {
      const dir = path.dirname(filePath);
      await mkdir(dir, { recursive: true });
      await writeFile(filePath, input.content, "utf-8");
      return { content: `Successfully wrote ${input.content.length} bytes to ${input.path}` };
    } catch (err) {
      return {
        content: `Error writing file: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
});
