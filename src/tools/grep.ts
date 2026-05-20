import { z } from "zod";
import { buildTool } from "./types.js";
import type { ToolUseContext, ToolResult } from "./types.js";
import { exec } from "child_process";
import * as path from "path";

const inputSchema = z.object({
  pattern: z.string().describe("The regex pattern to search for"),
  path: z.string().optional().describe("File or directory to search in (default: current directory)"),
  include: z.string().optional().describe("File glob to include (e.g., '*.ts')"),
  ignoreCase: z.boolean().optional().describe("Case-insensitive search (default: false)"),
});

async function hasCommand(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    exec(`which ${cmd} 2>/dev/null`, (error) => resolve(!error));
  });
}

export const grepTool = buildTool({
  name: "grep",
  description: "Search file contents using ripgrep (rg) or fallback grep",
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  call: async (input, context): Promise<ToolResult<string>> => {
    const searchPath = input.path
      ? path.resolve(context.workingDir, input.path)
      : context.workingDir;

    const useRg = await hasCommand("rg");

    let command: string;
    if (useRg) {
      const parts = ["rg"];
      if (input.ignoreCase) parts.push("-i");
      parts.push("--no-heading", "--line-number");
      if (input.include) parts.push("--glob", input.include);
      parts.push("--max-count", "200", "--", input.pattern, searchPath);
      command = parts.map(p => p.includes(" ") ? `"${p}"` : p).join(" ");
    } else {
      const parts = ["grep", "-rn"];
      if (input.ignoreCase) parts.push("-i");
      if (input.include) parts.push("--include", input.include);
      parts.push("--", input.pattern, searchPath);
      command = parts.map(p => p.includes(" ") ? `"${p}"` : p).join(" ");
    }

    return new Promise((resolve) => {
      exec(command, { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error && !stdout) {
          if ((error as { code?: number }).code === 1) {
            return resolve({ content: "No matches found" });
          }
          return resolve({ content: `Search error: ${stderr || error.message}`, isError: true });
        }
        resolve({ content: (stdout || "").trimEnd() || "No matches found" });
      });
    });
  },
});
