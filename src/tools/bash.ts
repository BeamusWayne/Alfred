/**
 * Run a shell command. Two layers of safety (ADR 0003):
 *   - a chain-aware kill-list in `checkPermissions` that returns DENY even
 *     under `bypass` (the engine never runs `rm -rf /`);
 *   - read-only command detection (every chained segment must be in an
 *     allowlist) so safe inspection auto-runs while anything else asks.
 *
 * NOTE: string matching is UX, not a security boundary. The real boundary is
 * an OS sandbox (ADR 0003 / a later phase). Until then bash asks by default.
 */
import { z } from "zod";
import { exec } from "node:child_process";
import { buildTool } from "./types.ts";
import type { ToolResult } from "./types.ts";
import { ask, deny } from "../permissions/types.ts";
import { resolveInside } from "./lib/paths.ts";

const inputSchema = z.object({
  command: z.string().describe("Shell command to execute"),
  timeout: z.number().int().positive().optional().describe("Timeout in ms (default 120000)"),
  cwd: z.string().optional().describe("Working directory (within the workspace)"),
});

const DEFAULT_TIMEOUT = 120_000;
const MAX_OUTPUT = 30_000;

const READ_ONLY = new Set([
  "ls", "cat", "head", "tail", "wc", "echo", "pwd", "which", "type", "find",
  "grep", "rg", "tree", "stat", "file", "date", "whoami", "env", "printenv",
  "basename", "dirname", "realpath", "diff", "sort", "uniq", "cut", "awk", "sed",
]);
const GIT_READ_ONLY = new Set(["status", "log", "diff", "branch", "show", "remote", "rev-parse"]);

const KILL_LIST: ReadonlyArray<RegExp> = [
  /\brm\s+(?:-[^\s]*\s+)*-[^\s]*[rf][^\s]*\s+(?:-[^\s]*\s+)*(?:\/|~|\$HOME|\/\*)(?:\s|$)/,
  /\bmkfs\b/,
  /\bdd\b[^\n]*\bof=\/dev\//,
  /:\(\)\s*\{\s*:\s*\|\s*:?\s*&\s*\}\s*;/, // fork bomb
  /\b(?:shutdown|reboot|halt|poweroff)\b/,
  />\s*\/dev\/(?:sd|nvme|disk)/,
  /\bchmod\s+-R\s+0?777\s+\//,
];

/** Split on shell operators (naive — quotes not honored; conservative on purpose). */
function segments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||&/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function firstToken(segment: string): { cmd: string; rest: string } {
  // drop leading VAR=value assignments
  const stripped = segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+/, "");
  const [head = "", ...rest] = stripped.split(/\s+/);
  const cmd = head.split("/").pop() ?? head; // /usr/bin/ls -> ls
  return { cmd, rest: rest.join(" ") };
}

function isReadOnlyCommand(command: string): boolean {
  const segs = segments(command);
  if (segs.length === 0) return false;
  return segs.every((seg) => {
    const { cmd, rest } = firstToken(seg);
    if (cmd === "git") {
      const sub = rest.split(/\s+/)[0] ?? "";
      return GIT_READ_ONLY.has(sub);
    }
    return READ_ONLY.has(cmd);
  });
}

function isDangerous(command: string): boolean {
  return KILL_LIST.some((re) => re.test(command));
}

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  return s.slice(0, MAX_OUTPUT) + `\n… (truncated, ${s.length - MAX_OUTPUT} more chars)`;
}

export const bashTool = buildTool({
  name: "bash",
  description: "Execute a shell command and return combined stdout/stderr and the exit code.",
  inputSchema,
  isReadOnly: (input) => isReadOnlyCommand(input.command),
  describeCall: (input) => `bash(${input.command.slice(0, 60)})`,
  checkPermissions: async (input) => {
    const command = (input as z.output<typeof inputSchema>).command;
    if (isDangerous(command)) return deny(`refusing dangerous command: ${command}`);
    return ask(`run: ${command}`);
  },
  call: async (input, ctx): Promise<ToolResult<string>> => {
    const cwd = input.cwd ? resolveInside(ctx.workingDir, input.cwd) : ctx.workingDir;
    const timeout = input.timeout ?? DEFAULT_TIMEOUT;
    return await new Promise<ToolResult<string>>((resolve) => {
      const child = exec(
        input.command,
        { cwd, timeout, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const out = (stdout ?? "") + (stderr ? `\n${stderr}` : "");
          if (err) {
            const code = typeof (err as { code?: number }).code === "number"
              ? (err as { code?: number }).code
              : 1;
            resolve({ content: truncate(`[exit ${code}]\n${out}`.trimEnd()), isError: true });
          } else {
            resolve({ content: truncate(out.trimEnd()) || "(no output)" });
          }
        },
      );
      const onAbort = () => child.kill("SIGTERM");
      ctx.signal.addEventListener("abort", onAbort, { once: true });
    });
  },
});
