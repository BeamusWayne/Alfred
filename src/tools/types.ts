import { z } from "zod";
import type { ContentBlock } from "../providers/types.js";

// --- Permission types ---

export type PermissionBehavior = "allow" | "deny" | "ask";

export interface PermissionResult {
  behavior: PermissionBehavior;
  updatedInput?: Record<string, unknown>;
  reason?: string;
}

export type PermissionMode = "default" | "plan" | "auto" | "bypass";

export interface ToolPermissionContext {
  mode: PermissionMode;
  allowedTools: Set<string>;
  deniedTools: Set<string>;
  workingDir: string;
}

// --- Tool result ---

export interface ToolResult<T = unknown> {
  content: T;
  isError?: boolean;
}

export interface ToolProgressData {
  message?: string;
  percentage?: number;
}

// --- Tool execution context ---

export interface ToolUseContext {
  abortController: AbortController;
  workingDir: string;
  readFileState: Map<string, string>;
  permissionContext: ToolPermissionContext;
  memoryDir?: string;
  onToolProgress?: (toolName: string, progress: ToolProgressData) => void;
}

// --- Core Tool interface ---

export interface Tool<
  Input extends z.ZodType<unknown> = z.ZodType<unknown>,
  Output = unknown,
> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Input;
  readonly aliases?: string[];

  call(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<ToolResult<Output>>;

  isEnabled(): boolean;
  isReadOnly(input: z.infer<Input>): boolean;
  isConcurrencySafe(input: z.infer<Input>): boolean;
  isDestructive(input: z.infer<Input>): boolean;

  checkPermissions(
    input: z.infer<Input>,
    context: ToolPermissionContext,
  ): Promise<PermissionResult>;

  userFacingName(input: z.infer<Input>): string;

  renderResult(result: ToolResult<Output>): ContentBlock[];
}

// --- Defaultable keys ---

type DefaultableToolKeys =
  | "isEnabled"
  | "isConcurrencySafe"
  | "isReadOnly"
  | "isDestructive"
  | "checkPermissions"
  | "userFacingName"
  | "renderResult";

const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input?: unknown) => false,
  isReadOnly: (_input?: unknown) => false,
  isDestructive: (_input?: unknown) => false,
  checkPermissions: (
    input: Record<string, unknown>,
    _ctx?: ToolPermissionContext,
  ): Promise<PermissionResult> =>
    Promise.resolve({ behavior: "allow" as const, updatedInput: input }),
  userFacingName: () => "",
  renderResult: (result: ToolResult<unknown>): ContentBlock[] => [
    { type: "text" as const, text: typeof result.content === "string" ? result.content : JSON.stringify(result.content) },
  ],
};

type ToolDefaults = typeof TOOL_DEFAULTS;

export type ToolDef<
  Input extends z.ZodType<unknown> = z.ZodType<unknown>,
  Output = unknown,
> = Omit<Tool<Input, Output>, DefaultableToolKeys> &
  Partial<Pick<Tool<Input, Output>, DefaultableToolKeys>>;

type BuiltTool<D> = Omit<D, DefaultableToolKeys> & {
  [K in DefaultableToolKeys]-?: K extends keyof D
    ? undefined extends D[K]
      ? ToolDefaults[K]
      : D[K]
    : ToolDefaults[K];
};

type AnyToolDef = ToolDef<any, any>;

export function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D> & Tool {
  return {
    ...TOOL_DEFAULTS,
    userFacingName: () => def.name,
    ...def,
  } as BuiltTool<D> & Tool;
}
