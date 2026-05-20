import { z } from "zod";
import { buildTool } from "./types.js";
import type { ToolUseContext, ToolResult } from "./types.js";
import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import * as path from "path";

const inputSchema = z.object({
  path: z.string().describe("Absolute or relative path to the file"),
  old_string: z.string().describe("The text to replace"),
  new_string: z.string().describe("The replacement text"),
  replace_all: z.boolean().optional().describe("Replace all occurrences (default: false)"),
});

export const fileEditTool = buildTool({
  name: "file_edit",
  description: "Edit a file by replacing a specific string with a new string",
  inputSchema,
  aliases: ["edit"],
  isDestructive: () => true,
  call: async (input, context): Promise<ToolResult<string>> => {
    const filePath = path.resolve(context.workingDir, input.path);

    if (!existsSync(filePath)) {
      return { content: `File not found: ${input.path}`, isError: true };
    }

    if (input.old_string === input.new_string) {
      return { content: "old_string and new_string are identical — no changes made", isError: true };
    }

    try {
      const content = await readFile(filePath, "utf-8");

      if (!content.includes(input.old_string)) {
        return { content: `old_string not found in ${input.path}`, isError: true };
      }

      const occurrences = content.split(input.old_string).length - 1;
      if (occurrences > 1 && !input.replace_all) {
        return {
          content: `Found ${occurrences} occurrences of old_string. Use replace_all: true to replace all, or provide more context to make old_string unique.`,
          isError: true,
        };
      }

      const newContent = input.replace_all
        ? content.split(input.old_string).join(input.new_string)
        : content.replace(input.old_string, input.new_string);

      await writeFile(filePath, newContent, "utf-8");
      return { content: `Replaced ${input.replace_all ? occurrences : 1} occurrence(s) in ${input.path}` };
    } catch (err) {
      return {
        content: `Error editing file: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
});
