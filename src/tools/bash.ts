import { z } from "zod";
import { buildTool } from "./types.js";
import type { ToolUseContext, ToolResult } from "./types.js";
import { exec } from "child_process";

const inputSchema = z.object({
  command: z.string().describe("The shell command to execute"),
  timeout: z.number().optional().describe("Timeout in milliseconds (default: 120000)"),
  cwd: z.string().optional().describe("Working directory for command execution"),
});

export const bashTool = buildTool({
  name: "bash",
  description: "Execute a shell command and return the output",
  inputSchema,
  isReadOnly: (input) => {
    const readOnlyCommands = ["ls", "cat", "head", "tail", "grep", "find", "wc", "echo", "pwd", "which", "type", "git status", "git log", "git diff", "git branch"];
    return readOnlyCommands.some((cmd) => input.command.trimStart().startsWith(cmd));
  },
  isDestructive: (input) => {
    const destructiveCommands = ["rm", "rmdir", "mkfs", "dd", "format", "shred"];
    return destructiveCommands.some((cmd) => input.command.trimStart().startsWith(cmd));
  },
  call: async (input, context): Promise<ToolResult<string>> => {
    const timeout = input.timeout ?? 120000;
    const cwd = input.cwd ?? context.workingDir;

    return new Promise((resolve) => {
      const child = exec(
        input.command,
        { cwd, timeout, maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            const exitCode = error.code ?? 1;
            resolve({
              content: `Exit code: ${exitCode}\n${stdout ?? ""}${stderr ? `\nStderr:\n${stderr}` : ""}`,
              isError: true,
            });
            return;
          }
          const output = (stdout ?? "") + (stderr ? `\nStderr:\n${stderr}` : "");
          resolve({ content: output.trimEnd() || "(no output)" });
        },
      );

      context.abortController.signal.addEventListener("abort", () => {
        child.kill("SIGTERM");
      });
    });
  },
});
