/**
 * Search file contents by regex. Read-only + concurrency-safe. JS-native (no
 * ripgrep dependency, so it's deterministic and hermetic in tests); a faster
 * ripgrep path can be added later behind the same interface.
 */
import { z } from "zod";
import { buildTool } from "./types.ts";
import type { ToolResult } from "./types.ts";
import { resolveInside } from "./lib/paths.ts";

const inputSchema = z.object({
  pattern: z.string().describe("Regular expression to search for"),
  path: z.string().optional().describe("Directory or file to search (default: workspace root)"),
  glob: z.string().optional().describe("Only search files matching this glob (default '**/*')"),
  ignoreCase: z.boolean().optional().describe("Case-insensitive match"),
});

const MAX_MATCHES = 200;
const MAX_FILE_BYTES = 1_000_000;
const IGNORED = ["node_modules/", ".git/", "dist/"];
const NUL = String.fromCharCode(0);

export const grepTool = buildTool({
  name: "grep",
  description: "Search file contents with a regular expression; returns file:line:text matches.",
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  describeCall: (input) => `grep(${input.pattern})`,
  call: async (input, ctx): Promise<ToolResult<string>> => {
    let re: RegExp;
    try {
      re = new RegExp(input.pattern, input.ignoreCase ? "i" : "");
    } catch (e) {
      return {
        content: `Invalid regex: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }

    const base = resolveInside(ctx.workingDir, input.path ?? ".");
    const glob = new Bun.Glob(input.glob ?? "**/*");
    const matches: string[] = [];
    let truncated = false;

    for await (const rel of glob.scan({ cwd: base, onlyFiles: true, dot: false })) {
      if (IGNORED.some((ig) => rel.includes(ig))) continue;
      const file = Bun.file(`${base}/${rel}`);
      if (file.size > MAX_FILE_BYTES) continue;
      let text: string;
      try {
        text = await file.text();
      } catch {
        continue;
      }
      if (text.includes(NUL)) continue; // skip binary files
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          matches.push(`${rel}:${i + 1}:${lines[i]!.slice(0, 300)}`);
          if (matches.length >= MAX_MATCHES) {
            truncated = true;
            break;
          }
        }
      }
      if (truncated) break;
    }

    if (matches.length === 0) return { content: `No matches for /${input.pattern}/` };
    return { content: matches.join("\n") + (truncated ? `\n… (capped at ${MAX_MATCHES})` : "") };
  },
});
