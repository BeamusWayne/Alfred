import { z } from "zod";
import { buildTool } from "./types.js";
import type { ToolUseContext, ToolResult } from "./types.js";
import { MemoryStore, type MemoryType } from "../memory/store.js";
import { searchMemories } from "../memory/search.js";

const createSchema = z.object({
  name: z.string().describe("Short kebab-case identifier for the memory"),
  type: z.enum(["user", "feedback", "project", "reference"]).describe("Memory type"),
  description: z.string().describe("One-line summary of the memory"),
  content: z.string().describe("Full memory content"),
});

const searchSchema = z.object({
  query: z.string().describe("Search query to find matching memories"),
});

const deleteSchema = z.object({
  name: z.string().describe("Name of the memory to delete"),
});

function getMemoryDir(context: ToolUseContext): string {
  return context.memoryDir || `${context.workingDir}/.alfred/memory`;
}

export const memoryCreateTool = buildTool({
  name: "memory_create",
  description: "Create a new memory entry",
  inputSchema: createSchema,
  call: async (input, context): Promise<ToolResult<string>> => {
    const store = new MemoryStore(getMemoryDir(context));
    const entry = await store.create({
      name: input.name,
      type: input.type as MemoryType,
      description: input.description,
      content: input.content,
    });
    return { content: `Created memory: ${entry.name}` };
  },
});

export const memorySearchTool = buildTool({
  name: "memory_search",
  description: "Search memories by query",
  inputSchema: searchSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  call: async (input, context): Promise<ToolResult<string>> => {
    const dir = getMemoryDir(context);
    const results = await searchMemories(dir, input.query);
    if (results.length === 0) return { content: "No matching memories" };
    return { content: results.map((r) => `[${r.type}] ${r.name}: ${r.description}`).join("\n") };
  },
});

export const memoryDeleteTool = buildTool({
  name: "memory_delete",
  description: "Delete a memory by name",
  inputSchema: deleteSchema,
  call: async (input, context): Promise<ToolResult<string>> => {
    const store = new MemoryStore(getMemoryDir(context));
    const deleted = await store.delete(input.name);
    if (!deleted) return { content: `Memory '${input.name}' not found`, isError: true };
    return { content: `Memory '${input.name}' deleted` };
  },
});
