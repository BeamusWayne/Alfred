/**
 * Memory tools: model-facing CRUD surface over the MemoryProvider.
 *
 * Three tools matching the Anthropic memory-tool pattern (ADR 0001 §4):
 *   memory_search  — read-only + concurrency-safe, FTS5-backed recall.
 *   memory_upsert  — insert/update a fact (model-curated write).
 *   memory_forget  — delete a fact by slug.
 *
 * The provider is rooted at `${ctx.workingDir}/.alfred/memory` so every
 * workspace gets its own isolated memory store.
 */
import { z } from "zod";
import { join } from "node:path";
import { buildTool } from "./types.ts";
import type { ToolResult } from "./types.ts";
import { LocalFileProvider } from "../memory/localFile.ts";
import { FactTypeSchema } from "../memory/types.ts";
import type { Fact } from "../memory/types.ts";
import { allow } from "../permissions/types.ts";

// ---------------------------------------------------------------------------
// Shared provider factory (one instance per working dir per process)
// ---------------------------------------------------------------------------

const providerCache = new Map<string, LocalFileProvider>();

function getProvider(workingDir: string): LocalFileProvider {
  const root = join(workingDir, ".alfred", "memory");
  const existing = providerCache.get(root);
  if (existing !== undefined) return existing;
  const provider = new LocalFileProvider(root);
  providerCache.set(root, provider);
  return provider;
}

// ---------------------------------------------------------------------------
// memory_search
// ---------------------------------------------------------------------------

const searchInputSchema = z.object({
  query: z.string().describe("Full-text search query over stored facts"),
  k: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Max number of results to return (default 10)"),
});

export const memorySearchTool = buildTool({
  name: "memory_search",
  description:
    "Search the agent memory store with a full-text query. " +
    "Returns matching facts (type, slug, content, timestamps). " +
    "Read-only and concurrency-safe.",
  inputSchema: searchInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  checkPermissions: async () => allow(),
  describeCall: (input) => `memory_search(${input.query})`,
  call: async (input, ctx): Promise<ToolResult<string>> => {
    const provider = getProvider(ctx.workingDir);
    let facts: readonly Fact[];
    try {
      facts = await provider.search(input.query);
    } catch (err) {
      return {
        content: `Memory search failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
    const k = input.k ?? 10;
    const slice = facts.slice(0, k);
    if (slice.length === 0) return { content: `No memory facts found for: ${input.query}` };
    const lines = slice.map(
      (f) =>
        `[${f.slug}] type=${f.type}${f.scope ? ` scope=${f.scope}` : ""} ts=${f.ts}\n${f.content}`,
    );
    return { content: lines.join("\n\n---\n\n") };
  },
});

// ---------------------------------------------------------------------------
// memory_upsert
// ---------------------------------------------------------------------------

const upsertInputSchema = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric + hyphens")
    .describe("Unique identifier for this fact, e.g. 'user-prefers-bun'"),
  type: FactTypeSchema.describe("Fact category: user | feedback | project | reference"),
  content: z.string().min(1).describe("The fact body (markdown OK)"),
  scope: z
    .string()
    .optional()
    .describe("Optional workspace-relative file/dir path this fact applies to"),
  ttl: z
    .string()
    .optional()
    .describe("Optional ISO-8601 expiry date after which the fact is stale, e.g. 2026-12-31"),
});

export const memoryUpsertTool = buildTool({
  name: "memory_upsert",
  description:
    "Insert or update a memory fact. Use a stable slug as the key — " +
    "upserting the same slug overwrites the previous value (update-don't-duplicate policy). " +
    "Check for contradictions with memory_search before writing.",
  inputSchema: upsertInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: async () => allow(),
  describeCall: (input) => `memory_upsert(${input.slug})`,
  call: async (input, ctx): Promise<ToolResult<string>> => {
    const provider = getProvider(ctx.workingDir);
    const candidate = {
      slug: input.slug,
      type: input.type,
      content: input.content,
      scope: input.scope,
      ts: new Date().toISOString(),
      ttl: input.ttl,
    };

    let fact: Fact;
    try {
      fact = await provider.upsert(candidate);
    } catch (err) {
      return {
        content: `memory_upsert failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
    return {
      content: `Stored fact [${fact.slug}] (${fact.type}) at ${fact.ts}`,
    };
  },
});

// ---------------------------------------------------------------------------
// memory_forget
// ---------------------------------------------------------------------------

const forgetInputSchema = z.object({
  slug: z.string().describe("The slug of the fact to permanently delete"),
});

export const memoryForgetTool = buildTool({
  name: "memory_forget",
  description:
    "Permanently delete a memory fact by slug. Use when a fact is wrong, " +
    "outdated, or superseded by a new upsert. No-op if the slug does not exist.",
  inputSchema: forgetInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: async () => allow(),
  describeCall: (input) => `memory_forget(${input.slug})`,
  call: async (input, ctx): Promise<ToolResult<string>> => {
    const provider = getProvider(ctx.workingDir);
    try {
      await provider.forget(input.slug);
    } catch (err) {
      return {
        content: `memory_forget failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
    return { content: `Deleted fact [${input.slug}] (no-op if it did not exist)` };
  },
});
