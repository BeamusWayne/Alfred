/** Zod-validated configuration with env + override layering. */
import { z } from "zod";
import { roleModelMapSchema, type RoleModelMap, type RoleSpec } from "./roles.ts";

export const PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypass"] as const;
export const PROVIDERS = ["anthropic", "openai", "google"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export const configSchema = z.object({
  provider: z.enum(PROVIDERS).default("anthropic"),
  model: z.string().min(1),
  /** Override the provider base URL (e.g. an Anthropic-compatible GLM endpoint). */
  baseUrl: z.string().optional(),
  maxTurns: z.number().int().positive().default(50),
  // maxTokens/maxContextTokens: undefined = derive from the model capability
  // catalog (src/config/modelCatalog.ts) instead of a one-size-fits-all value.
  maxTokens: z.number().int().positive().optional(),
  maxContextTokens: z.number().int().positive().optional(),
  /** Reasoning effort on supporting models; undefined = per-role default. */
  effort: z.enum(EFFORT_LEVELS).optional(),
  /** "none" opts out of adaptive thinking on models that support it. */
  thinking: z.enum(["adaptive", "none"]).optional(),
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
  readonly effort?: (typeof EFFORT_LEVELS)[number];
  readonly thinking?: "adaptive" | "none";
}

function effortFromEnv(): (typeof EFFORT_LEVELS)[number] | undefined {
  const e = process.env.ALFRED_EFFORT;
  return (EFFORT_LEVELS as readonly string[]).includes(e ?? "")
    ? (e as (typeof EFFORT_LEVELS)[number])
    : undefined;
}

function thinkingFromEnv(): "adaptive" | "none" | undefined {
  const t = process.env.ALFRED_THINKING;
  return t === "adaptive" || t === "none" ? t : undefined;
}

/** Sensible default model per provider (so `ALFRED_PROVIDER=google` doesn't
 *  fall back to a Claude id the Gemini API would 404 on). */
const DEFAULT_MODEL_BY_PROVIDER: Record<ProviderId, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
  google: "gemini-2.5-flash",
};

/**
 * Parse a role env value: a bare model id, or "provider:model" to pin the
 * role to a different provider (e.g. ALFRED_MODEL_EDITOR=openai:gpt-5.2).
 */
function parseRoleSpec(raw: string): RoleSpec {
  const idx = raw.indexOf(":");
  if (idx > 0) {
    const prefix = raw.slice(0, idx);
    if ((PROVIDERS as readonly string[]).includes(prefix)) {
      return { provider: prefix as ProviderId, model: raw.slice(idx + 1) };
    }
  }
  return raw;
}

/** Read per-role model overrides from the environment (ADR 0005). */
function parseRolesFromEnv(): RoleModelMap | undefined {
  const map: Record<string, RoleSpec> = {};
  const architect = process.env.ALFRED_MODEL_ARCHITECT;
  const editor = process.env.ALFRED_MODEL_EDITOR;
  const subagent = process.env.ALFRED_MODEL_SUBAGENT;
  if (architect) map.architect = parseRoleSpec(architect);
  if (editor) map.editor = parseRoleSpec(editor);
  if (subagent) map.subagent = parseRoleSpec(subagent);
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
    // ALFRED_BASE_URL means "Anthropic-compatible endpoint" (e.g. Zhipu GLM)
    // and is scoped to the anthropic provider — feeding it to google/openai
    // would point their requests at the wrong API.
    baseUrl: overrides.baseUrl ?? (provider === "anthropic" ? process.env.ALFRED_BASE_URL : undefined),
    maxTurns: overrides.maxTurns,
    maxTokens: overrides.maxTokens,
    maxContextTokens: overrides.maxContextTokens,
    effort: overrides.effort ?? effortFromEnv(),
    thinking: overrides.thinking ?? thinkingFromEnv(),
    permissionMode: overrides.permissionMode,
    roles: overrides.roles ?? parseRolesFromEnv(),
  });
}
