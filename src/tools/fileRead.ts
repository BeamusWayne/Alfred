/**
 * Read a file with line numbers. Read-only + concurrency-safe, so the engine
 * runs it in parallel. Records {content, mtime} in `readFileState` so the edit
 * and write tools can enforce read-before-write + a freshness check (ADR 0001
 * §7.2): you cannot edit a file you never read, and a concurrent external
 * change is detected instead of silently clobbered.
 */

import { stat } from "node:fs/promises";
import { z } from "zod";
import { resolveInside } from "./lib/paths.ts";
import type { ToolResult } from "./types.ts";
import { buildTool } from "./types.ts";

const inputSchema = z.object({
  path: z.string().describe("File path (absolute, or relative to the workspace root)"),
  offset: z.number().int().min(1).optional().describe("1-based line to start from"),
  limit: z.number().int().min(1).optional().describe("Max lines to read"),
});

const MAX_LINES = 2000;

export const fileReadTool = buildTool({
  name: "file_read",
  description:
    "Read a UTF-8 text file and return its contents with line numbers. " +
    "Use before editing a file.",
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  describeCall: (input) => `read(${input.path})`,
  call: async (input, ctx): Promise<ToolResult<string>> => {
    const abs = resolveInside(ctx.workingDir, input.path);
    const file = Bun.file(abs);
    if (!(await file.exists())) {
      return { content: `File not found: ${input.path}`, isError: true };
    }
    const text = await file.text();
    const info = await stat(abs);
    ctx.readFileState.set(abs, { content: text, mtimeMs: info.mtimeMs });

    const allLines = text.split("\n");
    const start = (input.offset ?? 1) - 1;
    const limit = input.limit ?? MAX_LINES;
    const slice = allLines.slice(start, start + limit);
    const width = String(start + slice.length).length;
    const numbered = slice
      .map((line, i) => `${String(start + i + 1).padStart(width)}\t${line}`)
      .join("\n");

    const truncated = start + slice.length < allLines.length;
    const note = truncated
      ? `\n… (${allLines.length - (start + slice.length)} more lines; use offset/limit)`
      : "";
    return { content: (numbered || "(empty file)") + note };
  },
});
