/**
 * Find files by glob pattern. Read-only + concurrency-safe. Uses Bun's native
 * glob; results are workspace-relative, sorted, and capped.
 */
import { z } from "zod";
import { buildTool } from "./types.ts";
import type { ToolResult } from "./types.ts";
import { resolveInside } from "./lib/paths.ts";

const inputSchema = z.object({
  pattern: z.string().describe("Glob pattern, e.g. 'src/**/*.ts'"),
  path: z.string().optional().describe("Directory to search from (default: workspace root)"),
});

const MAX_RESULTS = 500;
const IGNORED = ["node_modules/", ".git/", "dist/"];

export const globTool = buildTool({
  name: "glob",
  description: "List files matching a glob pattern (e.g. '**/*.test.ts').",
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  describeCall: (input) => `glob(${input.pattern})`,
  call: async (input, ctx): Promise<ToolResult<string>> => {
    const cwd = input.path ? resolveInside(ctx.workingDir, input.path) : ctx.workingDir;
    const glob = new Bun.Glob(input.pattern);
    const found: string[] = [];
    for await (const rel of glob.scan({ cwd, onlyFiles: true, dot: false })) {
      if (IGNORED.some((ig) => rel.includes(ig))) continue;
      found.push(rel);
      if (found.length >= MAX_RESULTS + 1) break;
    }
    found.sort();
    const capped = found.length > MAX_RESULTS;
    const list = found.slice(0, MAX_RESULTS).join("\n");
    if (!list) return { content: `No files match ${input.pattern}` };
    return { content: list + (capped ? `\n… (capped at ${MAX_RESULTS})` : "") };
  },
});
