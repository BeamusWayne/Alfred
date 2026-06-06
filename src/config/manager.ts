/** Zod-validated configuration with env + override layering. */
import { z } from "zod";
import { roleModelMapSchema, type RoleModelMap } from "./roles.ts";

export const PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypass"] as const;
export const PROVIDERS = ["anthropic", "openai"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const configSchema = z.object({
  provider: z.enum(PROVIDERS).default("anthropic"),
  model: z.string().min(1),
  maxTurns: z.number().int().positive().default(50),
  maxTokens: z.number().int().positive().default(8192),
  maxContextTokens: z.number().int().positive().default(200_000),
  permissionMode: z.enum(PERMISSION_MODES).default("default"),
  roles: roleModelMapSchema.optional(),
});

export type AlfredConfig = z.output<typeof configSchema>;

export interface ConfigOverrides {
  readonly provider?: ProviderId;
  readonly model?: string;
  readonly maxTurns?: number;
  readonly maxTokens?: number;
  readonly maxContextTokens?: number;
  readonly permissionMode?: (typeof PERMISSION_MODES)[number];
  readonly roles?: RoleModelMap;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";

/** Read per-role model overrides from the environment (ADR 0005). */
function parseRolesFromEnv(): RoleModelMap | undefined {
  const map: Record<string, string> = {};
  const architect = process.env.ALFRED_MODEL_ARCHITECT;
  const editor = process.env.ALFRED_MODEL_EDITOR;
  const subagent = process.env.ALFRED_MODEL_SUBAGENT;
  if (architect) map.architect = architect;
  if (editor) map.editor = editor;
  if (subagent) map.subagent = subagent;
  return Object.keys(map).length > 0 ? (map as RoleModelMap) : undefined;
}

function providerFromEnv(): ProviderId {
  return process.env.ALFRED_PROVIDER === "openai" ? "openai" : "anthropic";
}

export function loadConfig(overrides: ConfigOverrides = {}): AlfredConfig {
  return configSchema.parse({
    provider: overrides.provider ?? providerFromEnv(),
    model: overrides.model ?? process.env.ALFRED_MODEL ?? DEFAULT_MODEL,
    maxTurns: overrides.maxTurns,
    maxTokens: overrides.maxTokens,
    maxContextTokens: overrides.maxContextTokens,
    permissionMode: overrides.permissionMode,
    roles: overrides.roles ?? parseRolesFromEnv(),
  });
}
