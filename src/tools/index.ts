/** Tool registry — the built-in tool set the agent loop exposes to the model. */

import { skillTool } from "../skills/skillTool.ts";
import { spawnSubagentTool } from "./agentTool.ts";
import { bashTool } from "./bash.ts";
import { fileEditTool } from "./fileEdit.ts";
import { fileReadTool } from "./fileRead.ts";
import { fileWriteTool } from "./fileWrite.ts";
import { globTool } from "./glob.ts";
import { grepTool } from "./grep.ts";
import { memoryForgetTool, memorySearchTool, memoryUpsertTool } from "./memoryTool.ts";
import type { Tool } from "./types.ts";
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
  skillTool,
  spawnSubagentTool,
];

export function getAllTools(): readonly Tool[] {
  return BUILTIN.filter((t) => t.isEnabled());
}

export function findTool(tools: readonly Tool[], name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}

export type { Tool, ToolContext, ToolResult } from "./types.ts";
export { buildTool } from "./types.ts";
