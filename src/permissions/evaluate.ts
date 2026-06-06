/**
 * The single place that decides allow / ask / deny for a tool call.
 *
 * Precedence (ADR 0001 §7.3, ADR 0003) — the important property is that a
 * hard DENY (whole-tool denylist OR a tool's per-input kill-list) beats even
 * `bypass`. You can turn off prompts; you cannot turn off `rm -rf /`.
 *
 *   1. whole-tool denylist        → deny      (beats bypass)
 *   2. tool's own check says deny  → deny      (kill-list; beats bypass)
 *   3. read-only                   → allow
 *   4. plan mode + mutating        → deny
 *   5. allowlist / bypass          → allow
 *   6. acceptEdits + tool-allowed  → allow
 *   7. otherwise                   → the tool's decision (allow | ask)
 */
import type { PermissionResult, ToolPermissionContext } from "./types.ts";
import { allow, deny } from "./types.ts";

export interface EvaluateParams {
  readonly toolName: string;
  readonly isReadOnly: boolean;
  readonly input: Record<string, unknown>;
  readonly check: (
    input: Record<string, unknown>,
    ctx: ToolPermissionContext,
  ) => Promise<PermissionResult>;
  readonly ctx: ToolPermissionContext;
}

export async function evaluatePermission(p: EvaluateParams): Promise<PermissionResult> {
  const { toolName, isReadOnly, input, check, ctx } = p;

  // 1. Hard whole-tool deny — wins over everything, including bypass.
  if (ctx.deniedTools.has(toolName)) {
    return deny(`tool '${toolName}' is on the denylist`);
  }

  // 2. Ask the tool. Dangerous-input kill-lists live in the tool's check; a
  //    tool-level deny also beats bypass.
  const toolDecision = isReadOnly ? allow(input) : await check(input, ctx);
  if (toolDecision.behavior === "deny") return toolDecision;

  // 3. Read-only calls are always safe to run.
  if (isReadOnly) return allow(input);

  // 4. Plan mode forbids any mutation.
  if (ctx.mode === "plan") return deny("plan mode is read-only");

  // 5. Explicit allowlist or full bypass.
  if (ctx.allowedTools.has(toolName)) return allow(input);
  if (ctx.mode === "bypass") return allow(input);

  // 6. Defer to the tool (allow | ask). Edit tools return "allow" under
  //    acceptEdits themselves — the evaluator stays generic.
  return toolDecision;
}
