/**
 * Run a shell command. Layers of safety (ADR 0003 / ADR 0001 §7.3):
 *   - a chain-aware kill-list in `checkPermissions` that returns DENY even
 *     under `bypass` (the engine never runs `rm -rf /`);
 *   - read-only command detection (every chained segment must be in an
 *     allowlist) so safe inspection auto-runs while anything else asks;
 *   - optional OS sandbox (ALFRED_SANDBOX=1) that wraps the command in
 *     `sandbox-exec` on macOS (deny network + writes outside the workspace).
 *
 * NOTE: string matching is UX, not a security boundary. The real boundary is
 * the OS sandbox; until it is enabled, bash asks by default.
 */
import { z } from "zod";
import { execFile } from "node:child_process";
import { buildTool } from "./types.ts";
import type { ToolResult } from "./types.ts";
import { ask, deny } from "../permissions/types.ts";
import { resolveInside } from "./lib/paths.ts";
import { wrapCommand, defaultPolicy } from "../sandbox/index.ts";

const inputSchema = z.object({
  command: z.string().describe("Shell command to execute"),
  timeout: z.number().int().positive().optional().describe("Timeout in ms (default 120000)"),
  cwd: z.string().optional().describe("Working directory (within the workspace)"),
});

const DEFAULT_TIMEOUT = 120_000;
const MAX_OUTPUT = 30_000;

// Commands that only emit to stdout and cannot exec another program or write a
// file by themselves. Deliberately EXCLUDES awk/sed (their program or -i flag
// can write/exec) and env (runs an arbitrary command), which must never be
// auto-classified read-only. find/sort stay but their write/exec flags are
// caught by hasWriteIndicator below.
const READ_ONLY = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "echo",
  "pwd",
  "which",
  "type",
  "find",
  "grep",
  "rg",
  "tree",
  "stat",
  "file",
  "date",
  "whoami",
  "printenv",
  "basename",
  "dirname",
  "realpath",
  "diff",
  "sort",
  "uniq",
  "cut",
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

/**
 * True when the command can write a file or execute another program despite
 * naming only "read-only" tools — the cases that make naive classification
 * dangerous (a read-only-classified call skips approval). Conservative: when in
 * doubt it returns true, so the command falls through to a normal approval ask.
 */
function hasWriteIndicator(command: string): boolean {
  // Command / process substitution can run arbitrary code.
  if (command.includes("$(") || command.includes("`") || /[<>]\(/.test(command)) return true;
  // find's executor/deleter actions write or run programs.
  if (/\bfind\b[^|;&]*\s-(?:exec|execdir|ok|okdir|delete|fprint|fprintf|fls)\b/.test(command))
    return true;
  // sort -o writes its output to a file.
  if (/\bsort\b[^|;&]*\s-o\b/.test(command)) return true;
  // File-writing output redirection, excluding fd dups (2>&1) and the bit-bucket.
  const redir = command.replace(/\d?>&\d?/g, " ").replace(/>>?\s*\/dev\/null\b/g, " ");
  if (/>>?/.test(redir)) return true;
  return false;
}

function isReadOnlyCommand(command: string): boolean {
  if (hasWriteIndicator(command)) return false;
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
  // Also test a quote-stripped form so trivially-equivalent evasions like
  // `rm -rf "/"` / `rm -rf '/'` (which break the bare-`/` anchor) are still
  // caught. The kill-list is the one guard that survives bypass mode, so it
  // must not be defeatable by quoting the destructive target.
  const dequoted = command.replace(/['"]/g, "");
  return KILL_LIST.some((re) => re.test(command) || re.test(dequoted));
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

    // Optional OS sandbox (ADR 0001 §7.3). Transparent passthrough off-darwin.
    const sandboxed = process.env.ALFRED_SANDBOX === "1";
    const argv = sandboxed
      ? wrapCommand(input.command, defaultPolicy(cwd), process.platform).argv
      : ["sh", "-c", input.command];
    const file = argv[0] ?? "sh";
    const args = argv.slice(1);

    return await new Promise<ToolResult<string>>((resolve) => {
      const onAbort = (): void => {
        child.kill("SIGTERM");
        // Escalate if the child ignores SIGTERM (the execFile timeout is only a
        // backstop and does not fire on an external abort).
        setTimeout(() => child.kill("SIGKILL"), 2000).unref?.();
      };
      const child = execFile(
        file,
        args,
        { cwd, timeout, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          // Detach the abort listener on normal completion. ctx.signal is the
          // long-lived per-run signal shared by every tool call, and `{ once }`
          // only self-removes if abort actually fires — without this, each
          // completed bash call would leak a listener for the run's lifetime.
          ctx.signal.removeEventListener("abort", onAbort);
          const out = (stdout ?? "") + (stderr ? `\n${stderr}` : "");
          if (err) {
            const code =
              typeof (err as { code?: number }).code === "number"
                ? (err as { code?: number }).code
                : 1;
            resolve({ content: truncate(`[exit ${code}]\n${out}`.trimEnd()), isError: true });
          } else {
            resolve({ content: truncate(out.trimEnd()) || "(no output)" });
          }
        },
      );
      ctx.signal.addEventListener("abort", onAbort, { once: true });
    });
  },
});
