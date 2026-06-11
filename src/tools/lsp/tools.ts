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
import { allow } from "../../permissions/types.ts";
import { resolveInside } from "../lib/paths.ts";
import type { Tool, ToolResult } from "../types.ts";
import { buildTool } from "../types.ts";
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

/** Map a file extension to an LSP languageId (best-effort; defaults to plaintext). */
function languageIdFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescriptreact",
    mts: "typescript",
    cts: "typescript",
    js: "javascript",
    jsx: "javascriptreact",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    c: "c",
    h: "c",
    cpp: "cpp",
    hpp: "cpp",
    cc: "cpp",
  };
  return map[ext] ?? "plaintext";
}

/**
 * Open a document on demand before querying it.
 *
 * Servers like `typescript-language-server` answer definition/references/hover
 * only for documents that have been `textDocument/didOpen`-ed. The bootstrap
 * layer never opens files, so without this every query would come back empty.
 * We read the file from disk, send `didOpen` once per URI, and remember it so
 * repeat queries don't re-open. `firstOpen` triggers a brief settle so the
 * server can index the project before the first request races ahead of it.
 */
async function ensureOpen(
  client: LspClient,
  opened: Set<string>,
  opening: Map<string, Promise<void>>,
  uri: string,
  path: string,
): Promise<void> {
  if (opened.has(uri)) return;
  // Concurrency-safe: the LSP tools are isConcurrencySafe, so two calls for the
  // SAME not-yet-opened uri can run in parallel. Dedupe via an in-flight map so
  // exactly one didOpen is sent and the first-open settle fires exactly once.
  const inflight = opening.get(uri);
  if (inflight) return inflight;

  const open = (async (): Promise<void> => {
    let text: string;
    try {
      text = await Bun.file(path).text();
    } catch {
      return; // unreadable — let the query proceed and likely return empty
    }
    const isFirst = opened.size === 0;
    client.didOpen(uri, languageIdFor(path), text);
    opened.add(uri);
    // First open of the session: give the server a moment to load the project so
    // the immediately-following request sees a fully-indexed document.
    if (isFirst) {
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  })();

  opening.set(uri, open);
  try {
    await open;
  } finally {
    opening.delete(uri);
  }
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Build the set of LSP tools backed by `client`. These are wired into the
 * engine's tool set at startup by `bootstrapExtensions` (src/extensions/
 * bootstrap.ts) whenever `.alfred/lsp.json` declares a server.
 */
export function makeLspTools(client: LspClient): readonly Tool[] {
  // URIs already sent to the server via didOpen, shared across all three tools.
  const opened = new Set<string>();
  // In-flight opens, keyed by uri, so concurrent tool calls for the same file
  // share one didOpen instead of racing (the tools are isConcurrencySafe).
  const opening = new Map<string, Promise<void>>();

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

    call: async (input, ctx): Promise<ToolResult<string>> => {
      let abs: string;
      try {
        abs = resolveInside(ctx.workingDir, input.path);
      } catch {
        return {
          content: `lsp_definition error: path '${input.path}' is outside the workspace`,
          isError: true,
        };
      }
      const uri = toFileUri(abs);
      const pos = { line: input.line, character: input.character };
      try {
        await ensureOpen(client, opened, opening, uri, abs);
        const locations = await client.definition(uri, pos);
        return { content: formatLocations(locations), untrusted: true };
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

    call: async (input, ctx): Promise<ToolResult<string>> => {
      let abs: string;
      try {
        abs = resolveInside(ctx.workingDir, input.path);
      } catch {
        return {
          content: `lsp_references error: path '${input.path}' is outside the workspace`,
          isError: true,
        };
      }
      const uri = toFileUri(abs);
      const pos = { line: input.line, character: input.character };
      try {
        await ensureOpen(client, opened, opening, uri, abs);
        const locations = await client.references(uri, pos);
        return { content: formatLocations(locations), untrusted: true };
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

    call: async (input, ctx): Promise<ToolResult<string>> => {
      let abs: string;
      try {
        abs = resolveInside(ctx.workingDir, input.path);
      } catch {
        return {
          content: `lsp_hover error: path '${input.path}' is outside the workspace`,
          isError: true,
        };
      }
      const uri = toFileUri(abs);
      const pos = { line: input.line, character: input.character };
      try {
        await ensureOpen(client, opened, opening, uri, abs);
        const text = await client.hover(uri, pos);
        return { content: text ?? "(no hover info)", untrusted: true };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: `lsp_hover error: ${msg}`, isError: true };
      }
    },
  });

  return [lspDefinition, lspReferences, lspHover];
}
