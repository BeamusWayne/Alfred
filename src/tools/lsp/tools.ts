/**
 * LSP-backed agent tools: definition, references, hover.
 *
 * ADR 0002 (LSP client — IDE-grade code intelligence).
 *
 * All three tools are read-only and concurrency-safe — they issue LSP requests
 * that carry no side effects, so the engine may run them in parallel with other
 * read-only tools.  `checkPermissions` always returns `allow()`, matching the
 * pattern used for other read-only introspection tools.
 *
 * Input shape: `{ path, line, character }` — callers provide a workspace-
 * relative or absolute file path plus a 0-based line/character position.
 * The tool converts path → `file://` URI before forwarding to the LSP client.
 */

import { z } from "zod";
import { buildTool } from "../types.ts";
import type { Tool, ToolResult } from "../types.ts";
import { allow } from "../../permissions/types.ts";
import type { LspClient } from "./client.ts";
import type { Location } from "./protocol.ts";

// ---------------------------------------------------------------------------
// Shared input schema
// ---------------------------------------------------------------------------

const positionSchema = z.object({
  path: z.string().describe("Absolute path to the source file"),
  line: z.number().int().min(0).describe("0-based line number"),
  character: z.number().int().min(0).describe("0-based character offset"),
});

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function pathFromUri(uri: string): string {
  // file:///abs/path → /abs/path
  if (uri.startsWith("file://")) return decodeURIComponent(uri.slice("file://".length));
  return uri;
}

function formatLocations(locations: readonly Location[]): string {
  if (locations.length === 0) return "(no results)";
  return locations
    .map((loc) => {
      const file = pathFromUri(loc.uri);
      const line = loc.range.start.line + 1; // display as 1-based
      const char = loc.range.start.character + 1;
      return `${file}:${line}:${char}`;
    })
    .join("\n");
}

function toFileUri(path: string): string {
  if (path.startsWith("file://")) return path;
  const encoded = path.replace(/\\/g, "/").replace(/ /g, "%20");
  return `file://${encoded.startsWith("/") ? encoded : `/${encoded}`}`;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Build the set of LSP tools backed by `client`.
 * Pass the returned array as extra `tools` to `runQuery` (see INTEGRATION NOTES
 * in src/index.ts once `bootstrapLsp` is wired up).
 */
export function makeLspTools(client: LspClient): readonly Tool[] {
  const lspDefinition = buildTool({
    name: "lsp_definition",
    description:
      "Go to definition: resolve the declaration location(s) for the symbol at the given position. " +
      "Returns file path and line number. Much faster than grep for large codebases.",
    inputSchema: positionSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    checkPermissions: async () => allow(),
    describeCall: (input) => `lsp_definition(${input.path}:${input.line}:${input.character})`,

    call: async (input): Promise<ToolResult<string>> => {
      const uri = toFileUri(input.path);
      const pos = { line: input.line, character: input.character };
      try {
        const locations = await client.definition(uri, pos);
        return { content: formatLocations(locations) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: `lsp_definition error: ${msg}`, isError: true };
      }
    },
  });

  const lspReferences = buildTool({
    name: "lsp_references",
    description:
      "Find all references to the symbol at the given position across the workspace. " +
      "Returns a newline-separated list of file:line:char locations.",
    inputSchema: positionSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    checkPermissions: async () => allow(),
    describeCall: (input) => `lsp_references(${input.path}:${input.line}:${input.character})`,

    call: async (input): Promise<ToolResult<string>> => {
      const uri = toFileUri(input.path);
      const pos = { line: input.line, character: input.character };
      try {
        const locations = await client.references(uri, pos);
        return { content: formatLocations(locations) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: `lsp_references error: ${msg}`, isError: true };
      }
    },
  });

  const lspHover = buildTool({
    name: "lsp_hover",
    description:
      "Retrieve hover information (type signature, doc comment) for the symbol at the given position. " +
      "Returns the text, or '(no hover info)' if the server has nothing to say.",
    inputSchema: positionSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    checkPermissions: async () => allow(),
    describeCall: (input) => `lsp_hover(${input.path}:${input.line}:${input.character})`,

    call: async (input): Promise<ToolResult<string>> => {
      const uri = toFileUri(input.path);
      const pos = { line: input.line, character: input.character };
      try {
        const text = await client.hover(uri, pos);
        return { content: text ?? "(no hover info)" };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: `lsp_hover error: ${msg}`, isError: true };
      }
    },
  });

  return [lspDefinition, lspReferences, lspHover];
}
