/**
 * Tool contract + `buildTool()` factory.
 *
 * Every tool declares capability flags so the engine can make safe decisions
 * without guessing: read-only + concurrency-safe tools run in parallel; the
 * rest run serially (ADR 0001 P3 — the loop is deterministic, not vibes).
 *
 * Defaults are deliberately conservative: a tool is treated as NOT read-only,
 * NOT concurrency-safe and NOT auto-allowed unless it says so.
 */
import type { z } from "zod";
import type { ContentBlock } from "../providers/types.ts";
import type { PermissionResult, ToolPermissionContext } from "../permissions/types.ts";
import { allow } from "../permissions/types.ts";

export interface ToolResult<T = unknown> {
  readonly content: T;
  readonly isError?: boolean;
  /** Marks content derived from untrusted sources (web/MCP) — ADR 0003. */
  readonly untrusted?: boolean;
}

export interface ToolContext {
  readonly workingDir: string;
  readonly signal: AbortSignal;
  /** Path -> last-read snapshot, enabling read-before-write + mtime checks. */
  readonly readFileState: Map<string, { content: string; mtimeMs: number }>;
  readonly permissions: ToolPermissionContext;
  /**
   * Run an isolated sub-agent and return its final answer (spawn_subagent
   * tool). Injected by the engine at depth 0 only — absent means nesting is
   * not allowed. Usage/cost of the sub-run accrue to the parent run.
   */
  readonly spawnSubagent?: (
    task: string,
    opts: { readonly readOnly: boolean },
  ) => Promise<{ readonly text: string; readonly turns: number; readonly status: string }>;
}

export interface Tool<In extends z.ZodTypeAny = z.ZodTypeAny, Out = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: In;

  call(input: z.output<In>, ctx: ToolContext): Promise<ToolResult<Out>>;

  isEnabled(): boolean;
  isReadOnly(input: z.output<In>): boolean;
  isConcurrencySafe(input: z.output<In>): boolean;
  checkPermissions(input: z.output<In>, ctx: ToolPermissionContext): Promise<PermissionResult>;

  /** Short human label for a call, e.g. `bash(ls -la)`. */
  describeCall(input: z.output<In>): string;
  /** Render a result into content blocks for the transcript. */
  render(result: ToolResult<Out>): readonly ContentBlock[];
}

/** The fields a tool author may omit; the factory fills sensible defaults. */
type Optional =
  | "isEnabled"
  | "isReadOnly"
  | "isConcurrencySafe"
  | "checkPermissions"
  | "describeCall"
  | "render";

export type ToolSpec<In extends z.ZodTypeAny, Out> = Omit<Tool<In, Out>, Optional> &
  Partial<Pick<Tool<In, Out>, Optional>>;

export function buildTool<In extends z.ZodTypeAny, Out>(
  spec: ToolSpec<In, Out>,
): Tool<In, Out> {
  return {
    isEnabled: () => true,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    checkPermissions: async () => allow(),
    describeCall: () => spec.name,
    render: (result) => [
      {
        type: "text",
        text:
          typeof result.content === "string"
            ? result.content
            : JSON.stringify(result.content),
      },
    ],
    ...spec,
  };
}
