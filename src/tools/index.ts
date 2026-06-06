/** Tool registry — the built-in tool set the agent loop exposes to the model. */
import type { Tool } from "./types.ts";
import { fileReadTool } from "./fileRead.ts";
import { fileWriteTool } from "./fileWrite.ts";
import { fileEditTool } from "./fileEdit.ts";
import { bashTool } from "./bash.ts";
import { globTool } from "./glob.ts";
import { grepTool } from "./grep.ts";
import { memorySearchTool, memoryUpsertTool, memoryForgetTool } from "./memoryTool.ts";
import { webFetchTool } from "./webFetch.ts";

const BUILTIN: readonly Tool[] = [
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  bashTool,
  globTool,
  grepTool,
  memorySearchTool,
  memoryUpsertTool,
  memoryForgetTool,
  webFetchTool,
];

export function getAllTools(): readonly Tool[] {
  return BUILTIN.filter((t) => t.isEnabled());
}

export function findTool(tools: readonly Tool[], name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}

export { buildTool } from "./types.ts";
export type { Tool, ToolContext, ToolResult } from "./types.ts";
