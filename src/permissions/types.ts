/**
 * Permission types — kept free of any `tools` import so both `tools` and the
 * `permissions` evaluator can depend on this module without a cycle.
 *
 * Two orthogonal ideas (ADR 0001 / ADR 0003):
 *   - a tiered approval *policy* (this module): when to allow/ask/deny;
 *   - an OS sandbox (separate): what the process can physically do.
 */

export type PermissionBehavior = "allow" | "ask" | "deny";

/**
 * The result of a permission check. `updatedInput` lets a check rewrite the
 * tool input (e.g. a PreToolUse hook); the engine MUST honor it.
 */
export interface PermissionResult {
  readonly behavior: PermissionBehavior;
  readonly updatedInput?: Record<string, unknown>;
  readonly reason?: string;
}

/**
 * - `default` — ask before non-readonly tools.
 * - `acceptEdits` — auto-allow edits within the workspace, still ask for the rest.
 * - `plan` — read-only; deny anything that mutates.
 * - `bypass` — allow everything EXCEPT hard-denied tools (the kill-list still wins).
 */
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypass";

export interface ToolPermissionContext {
  readonly mode: PermissionMode;
  readonly allowedTools: ReadonlySet<string>;
  readonly deniedTools: ReadonlySet<string>;
  readonly workingDir: string;
}

export function allow(updatedInput?: Record<string, unknown>): PermissionResult {
  return updatedInput ? { behavior: "allow", updatedInput } : { behavior: "allow" };
}

export function ask(reason: string): PermissionResult {
  return { behavior: "ask", reason };
}

export function deny(reason: string): PermissionResult {
  return { behavior: "deny", reason };
}
