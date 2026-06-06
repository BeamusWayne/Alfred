/**
 * Edit a file by content-anchored replacement (ADR 0001 §7.2):
 *   - read-before-write: the model must have read the file this session;
 *   - freshness: the on-disk mtime must match what we last read (else an
 *     external change is detected, not silently clobbered);
 *   - fuzzy locate: tolerate whitespace drift via the `seekSequence` ladder;
 *   - ambiguity is an error: a non-unique match must be disambiguated or use
 *     `replace_all`;
 *   - post-edit syntax check: reject an edit whose result would not parse
 *     (ADR 0002), so syntactically broken code is never written to disk.
 */
import { z } from "zod";
import { stat } from "node:fs/promises";
import { buildTool } from "./types.ts";
import type { ToolResult } from "./types.ts";
import type { PermissionResult, ToolPermissionContext } from "../permissions/types.ts";
import { allow, ask, deny } from "../permissions/types.ts";
import { isInside, resolveInside } from "./lib/paths.ts";
import { locate } from "./lib/seekSequence.ts";
import { checkSyntax } from "./lib/syntaxCheck.ts";

const inputSchema = z.object({
  path: z.string().describe("File to edit (absolute or relative to workspace root)"),
  old_string: z.string().describe("Existing text to replace (located by content, not line number)"),
  new_string: z.string().describe("Replacement text"),
  replace_all: z.boolean().optional().describe("Replace every exact occurrence"),
});

function checkEditPermission(path: string, ctx: ToolPermissionContext): PermissionResult {
  if (!isInside(ctx.workingDir, path)) {
    return deny(`refusing to edit outside the workspace: ${path}`);
  }
  if (ctx.mode === "acceptEdits") return allow();
  return ask(`edit ${path}`);
}

export const fileEditTool = buildTool({
  name: "file_edit",
  description:
    "Replace a unique snippet in a file. Read the file first. Match is located " +
    "by surrounding content (whitespace-tolerant); ambiguous matches are rejected.",
  inputSchema,
  isReadOnly: () => false,
  describeCall: (input) => `edit(${input.path})`,
  checkPermissions: async (input, ctx) =>
    checkEditPermission((input as z.output<typeof inputSchema>).path, ctx),
  call: async (input, ctx): Promise<ToolResult<string>> => {
    const abs = resolveInside(ctx.workingDir, input.path);

    const remembered = ctx.readFileState.get(abs);
    if (!remembered) {
      return { content: `Read ${input.path} before editing it.`, isError: true };
    }
    if (!(await Bun.file(abs).exists())) {
      return { content: `File not found: ${input.path}`, isError: true };
    }
    const info = await stat(abs);
    if (info.mtimeMs !== remembered.mtimeMs) {
      return {
        content: `${input.path} changed on disk since you read it — re-read before editing.`,
        isError: true,
      };
    }

    const content = await Bun.file(abs).text();
    if (input.old_string === input.new_string) {
      return { content: "old_string and new_string are identical — nothing to do.", isError: true };
    }

    const found = locate(content, input.old_string);
    if (!found) {
      return { content: `Could not find old_string in ${input.path}.`, isError: true };
    }
    if (found.count > 1 && !input.replace_all) {
      return {
        content: `old_string matches ${found.count} places in ${input.path} — add context or set replace_all.`,
        isError: true,
      };
    }

    let next: string;
    let n = 1;
    if (input.replace_all && found.strategy === "exact") {
      const parts = content.split(input.old_string);
      n = parts.length - 1;
      next = parts.join(input.new_string);
    } else {
      next = content.slice(0, found.start) + input.new_string + content.slice(found.end);
    }

    const syntax = checkSyntax(input.path, next);
    if (!syntax.ok) {
      return { content: `Edit would break ${input.path} syntax: ${syntax.error}`, isError: true };
    }

    await Bun.write(abs, next);
    const after = await stat(abs);
    ctx.readFileState.set(abs, { content: next, mtimeMs: after.mtimeMs });

    const how = found.strategy === "exact" ? "" : ` (matched via ${found.strategy})`;
    return { content: `Edited ${input.path} — ${n} replacement${n === 1 ? "" : "s"}${how}.` };
  },
});
