import type { Tool, ToolPermissionContext } from "./types.js";

const toolRegistry = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
  toolRegistry.set(tool.name, tool);
  if (tool.aliases) {
    for (const alias of tool.aliases) {
      toolRegistry.set(alias, tool);
    }
  }
}

export function getTool(name: string): Tool | undefined {
  return toolRegistry.get(name);
}

export function getAllTools(): readonly Tool[] {
  const seen = new Set<string>();
  const tools: Tool[] = [];
  for (const tool of toolRegistry.values()) {
    if (!seen.has(tool.name)) {
      seen.add(tool.name);
      tools.push(tool);
    }
  }
  return tools;
}

export function getEnabledTools(ctx: ToolPermissionContext): readonly Tool[] {
  return getAllTools().filter((t) => t.isEnabled());
}

export function toolMatchesName(tool: Tool, name: string): boolean {
  return tool.name === name || (tool.aliases?.includes(name) ?? false);
}

export function findToolByName(tools: readonly Tool[], name: string): Tool | undefined {
  return tools.find((t) => toolMatchesName(t, name));
}

export function clearTools(): void {
  toolRegistry.clear();
}

export { buildTool } from "./types.js";
export type { Tool, ToolDef, ToolResult, ToolUseContext, ToolPermissionContext, PermissionResult, PermissionMode } from "./types.js";
