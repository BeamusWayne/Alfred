/**
 * Write (create or overwrite) a file. Mutating, so it asks for approval in
 * `default` mode and auto-allows under `acceptEdits` (the tool owns that
 * semantic; the evaluator stays generic). Path-jailed to the workspace.
 */
import { z } from "zod";
import { stat } from "node:fs/promises";
import { buildTool } from "./types.ts";
import type { ToolResult } from "./types.ts";
import type { PermissionResult, ToolPermissionContext } from "../permissions/types.ts";
import { allow, ask, deny } from "../permissions/types.ts";
import { isInside, resolveInside } from "./lib/paths.ts";

const inputSchema = z.object({
  path: z.string().describe("File path to write (absolute or relative to workspace root)"),
  content: z.string().describe("Full file contents to write"),
});

function checkWritePermission(
  path: string,
  ctx: ToolPermissionContext,
): PermissionResult {
  if (!isInside(ctx.workingDir, path)) {
    return deny(`refusing to write outside the workspace: ${path}`);
  }
  if (ctx.mode === "acceptEdits") return allow();
  return ask(`write ${path}`);
}

export const fileWriteTool = buildTool({
  name: "file_write",
  description: "Create a new file or overwrite an existing one with the given contents.",
  inputSchema,
  isReadOnly: () => false,
  describeCall: (input) => `write(${input.path})`,
  checkPermissions: async (input, ctx) =>
    checkWritePermission((input as z.output<typeof inputSchema>).path, ctx),
  call: async (input, ctx): Promise<ToolResult<string>> => {
    const abs = resolveInside(ctx.workingDir, input.path);
    const existed = await Bun.file(abs).exists();
    await Bun.write(abs, input.content);
    const info = await stat(abs);
    ctx.readFileState.set(abs, { content: input.content, mtimeMs: info.mtimeMs });
    const bytes = Buffer.byteLength(input.content, "utf8");
    return { content: `${existed ? "Overwrote" : "Created"} ${input.path} (${bytes} bytes)` };
  },
});
