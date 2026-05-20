import type { PermissionBehavior, PermissionMode, PermissionResult, ToolPermissionContext } from "../tools/types.js";

export interface PermissionRule {
  tool: string;
  behavior: PermissionBehavior;
  reason?: string;
}

export interface PermissionConfig {
  mode: PermissionMode;
  allowedTools: string[];
  deniedTools: string[];
  rules: PermissionRule[];
}

export function createPermissionContext(config: PermissionConfig, workingDir: string): ToolPermissionContext {
  return {
    mode: config.mode,
    allowedTools: new Set(config.allowedTools),
    deniedTools: new Set(config.deniedTools),
    workingDir,
  };
}

export function evaluatePermission(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolCheckPermissions: (input: Record<string, unknown>, ctx: ToolPermissionContext) => Promise<PermissionResult>,
  context: ToolPermissionContext,
): Promise<PermissionResult> {
  if (context.deniedTools.has(toolName)) {
    return Promise.resolve({
      behavior: "deny",
      reason: `Tool '${toolName}' is in the denied list`,
    });
  }

  if (context.mode === "bypass") {
    return Promise.resolve({ behavior: "allow", updatedInput: toolInput });
  }

  if (context.allowedTools.has(toolName)) {
    return Promise.resolve({ behavior: "allow", updatedInput: toolInput });
  }

  if (context.mode === "auto") {
    return toolCheckPermissions(toolInput, context);
  }

  if (context.mode === "plan") {
    return Promise.resolve({
      behavior: "deny",
      reason: "Tool execution is disabled in plan mode",
    });
  }

  return toolCheckPermissions(toolInput, context);
}

export function parsePermissionMode(value: string): PermissionMode {
  const valid: PermissionMode[] = ["default", "plan", "auto", "bypass"];
  if (valid.includes(value as PermissionMode)) return value as PermissionMode;
  throw new Error(`Invalid permission mode: ${value}. Valid modes: ${valid.join(", ")}`);
}
