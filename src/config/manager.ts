/** Zod-validated configuration with env + override layering. */
import { z } from "zod";
import { roleModelMapSchema, type RoleModelMap } from "./roles.ts";

export const PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypass"] as const;
export const PROVIDERS = ["anthropic", "openai", "google"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const configSchema = z.object({
  provider: z.enum(PROVIDERS).default("anthropic"),
  model: z.string().min(1),
  /** Override the provider base URL (e.g. an Anthropic-compatible GLM endpoint). */
  baseUrl: z.string().optional(),
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
  readonly baseUrl?: string;
  readonly maxTurns?: number;
  readonly maxTokens?: number;
  readonly maxContextTokens?: number;
  readonly permissionMode?: (typeof PERMISSION_MODES)[number];
  readonly roles?: RoleModelMap;
}

/** Sensible default model per provider (so `ALFRED_PROVIDER=google` doesn't
 *  fall back to a Claude id the Gemini API would 404 on). */
const DEFAULT_MODEL_BY_PROVIDER: Record<ProviderId, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
  google: "gemini-2.5-flash",
};

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
  const p = process.env.ALFRED_PROVIDER;
  return p === "openai" || p === "google" ? p : "anthropic";
}

export function loadConfig(overrides: ConfigOverrides = {}): AlfredConfig {
  const provider = overrides.provider ?? providerFromEnv();
  return configSchema.parse({
    provider,
    model: overrides.model ?? process.env.ALFRED_MODEL ?? DEFAULT_MODEL_BY_PROVIDER[provider],
    baseUrl: overrides.baseUrl ?? process.env.ALFRED_BASE_URL,
    maxTurns: overrides.maxTurns,
    maxTokens: overrides.maxTokens,
    maxContextTokens: overrides.maxContextTokens,
    permissionMode: overrides.permissionMode,
    roles: overrides.roles ?? parseRolesFromEnv(),
  });
}
