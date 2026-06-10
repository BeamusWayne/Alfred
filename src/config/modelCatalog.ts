/**
 * Model capability catalog — the single place that answers "what can this
 * model do?" so the engine and providers stop hardcoding one model family's
 * limits and quirks.
 *
 * Per-model facts captured here:
 *   - context window + max output, so compaction triggers and `max_tokens`
 *     defaults follow the model instead of a global constant;
 *   - thinking support ("adaptive" is the only on-mode for Fable 5 / Opus
 *     4.7+; older models use budget thinking; everything else none);
 *   - whether sampling params are accepted (Fable 5 / Opus 4.7+ return 400
 *     for `temperature`);
 *   - whether `output_config.effort` / `task_budget` are supported;
 *   - a coarse capability tier that downstream harness defaults key off.
 *
 * Matching is longest-prefix so date-suffixed ids ("claude-opus-4-5-20251101")
 * resolve to their family entry. Unknown models get a conservative default.
 */

import type { Effort } from "../providers/types.ts";

export type ThinkingSupport = "adaptive" | "budget" | "none";

/** Coarse capability tier; drives harness defaults (iteration budget, best-of-N). */
export type ModelTier = "frontier" | "strong" | "small";

export interface ModelProfile {
  /** Maximum input context in tokens. */
  readonly contextWindow: number;
  /** Maximum output tokens per response. */
  readonly maxOutput: number;
  /** Which thinking parameter shape the model accepts. */
  readonly thinking: ThinkingSupport;
  /** False on models that 400 when `temperature` is sent (Fable 5, Opus 4.7+). */
  readonly supportsTemperature: boolean;
  /** True when `output_config.effort` is accepted. */
  readonly supportsEffort: boolean;
  /** True when `output_config.task_budget` (beta) is accepted. */
  readonly supportsTaskBudget: boolean;
  readonly tier: ModelTier;
}

/** Conservative default for unknown model ids. */
export const DEFAULT_PROFILE: ModelProfile = {
  contextWindow: 128_000,
  maxOutput: 8_192,
  thinking: "none",
  supportsTemperature: true,
  supportsEffort: false,
  supportsTaskBudget: false,
  tier: "strong",
};

const FRONTIER_ANTHROPIC = {
  contextWindow: 1_000_000,
  maxOutput: 128_000,
  thinking: "adaptive",
  supportsTemperature: false,
  supportsEffort: true,
  supportsTaskBudget: true,
  tier: "frontier",
} as const satisfies ModelProfile;

/**
 * Keyed by model-id prefix. Sources: Anthropic models overview + migration
 * guide (2026-06); Google/Zhipu public docs. Extend by spreading:
 * `{ ...MODEL_CATALOG, "my-model": {...} }`.
 */
export const MODEL_CATALOG: Readonly<Record<string, ModelProfile>> = {
  "claude-fable-5": FRONTIER_ANTHROPIC,
  "claude-opus-4-8": FRONTIER_ANTHROPIC,
  "claude-opus-4-7": FRONTIER_ANTHROPIC,
  "claude-opus-4-6": {
    ...FRONTIER_ANTHROPIC,
    // 4.6 still accepts temperature and predates task budgets.
    supportsTemperature: true,
    supportsTaskBudget: false,
  },
  "claude-opus-4-5": {
    contextWindow: 200_000,
    maxOutput: 64_000,
    thinking: "budget",
    supportsTemperature: true,
    supportsEffort: true,
    supportsTaskBudget: false,
    tier: "strong",
  },
  "claude-sonnet-4-6": {
    contextWindow: 1_000_000,
    maxOutput: 64_000,
    thinking: "adaptive",
    supportsTemperature: true,
    supportsEffort: true,
    supportsTaskBudget: false,
    tier: "strong",
  },
  "claude-sonnet-4-5": {
    contextWindow: 200_000,
    maxOutput: 64_000,
    thinking: "budget",
    supportsTemperature: true,
    supportsEffort: false,
    supportsTaskBudget: false,
    tier: "strong",
  },
  "claude-haiku-4-5": {
    contextWindow: 200_000,
    maxOutput: 64_000,
    thinking: "budget",
    supportsTemperature: true,
    supportsEffort: false,
    supportsTaskBudget: false,
    tier: "small",
  },
  // Gemini: generous windows; thinking/effort are Anthropic params — never sent.
  "gemini-2.5-pro": {
    contextWindow: 1_000_000,
    maxOutput: 65_536,
    thinking: "none",
    supportsTemperature: true,
    supportsEffort: false,
    supportsTaskBudget: false,
    tier: "strong",
  },
  "gemini-2.5-flash": {
    contextWindow: 1_000_000,
    maxOutput: 65_536,
    thinking: "none",
    supportsTemperature: true,
    supportsEffort: false,
    supportsTaskBudget: false,
    tier: "small",
  },
  "gemini-2.0-flash": {
    contextWindow: 1_000_000,
    maxOutput: 8_192,
    thinking: "none",
    supportsTemperature: true,
    supportsEffort: false,
    supportsTaskBudget: false,
    tier: "small",
  },
  // Zhipu GLM via the Anthropic-compatible endpoint: must NOT receive
  // anthropic thinking/effort params, hence thinking "none".
  "glm-": {
    contextWindow: 128_000,
    maxOutput: 8_192,
    thinking: "none",
    supportsTemperature: true,
    supportsEffort: false,
    supportsTaskBudget: false,
    tier: "strong",
  },
};

/**
 * Resolve a model id to its capability profile via longest-prefix match.
 * Unknown ids get {@link DEFAULT_PROFILE}. Deterministic; never throws.
 */
export function modelProfile(modelId: string): ModelProfile {
  let bestKey = "";
  for (const key of Object.keys(MODEL_CATALOG)) {
    if (modelId.startsWith(key) && key.length > bestKey.length) bestKey = key;
  }
  return bestKey === "" ? DEFAULT_PROFILE : (MODEL_CATALOG[bestKey] ?? DEFAULT_PROFILE);
}

/**
 * Default `max_tokens` for a request. Streaming requests get headroom up to
 * 64K (no HTTP-timeout risk); non-streaming stays ≤16K so responses return
 * before SDK timeouts. Always capped by the model's own output ceiling.
 */
export function defaultMaxTokens(profile: ModelProfile, streaming: boolean): number {
  return Math.min(profile.maxOutput, streaming ? 64_000 : 16_000);
}

/**
 * Default `effort` by role (only sent to models with effort support):
 * the architect thinks hardest, the editor balances cost, subagents and
 * utility calls stay cheap. Callers can override per query.
 */
export function defaultEffortForRole(role: "architect" | "editor" | "subagent" | undefined): Effort | undefined {
  switch (role) {
    case "architect":
      return "xhigh";
    case "editor":
      return "medium";
    case "subagent":
      return "low";
    default:
      return undefined;
  }
}
