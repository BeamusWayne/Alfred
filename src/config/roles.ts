/**
 * Role-based model routing for Alfred's architect/editor/subagent split.
 *
 * ADR 0005: A strong reasoning model plans (architect), a fast cheap model
 * applies edits (editor), and a subagent handles delegated subtasks. Routing
 * is deterministic and config-driven; no model decisions here.
 *
 * Each role slot accepts either a bare model id ("claude-fable-5") or a
 * provider-qualified target ({provider: "openai", model: "gpt-5.2"}), so the
 * architect can run on one provider and the editor on another. The engine
 * resolves the provider instance per fallback-chain entry.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Role = "architect" | "editor" | "subagent";

/** Known provider ids — kept literal here to avoid a circular import with the
 *  config manager (which imports this module). Must match `ProviderName`. */
const PROVIDER_NAMES = ["anthropic", "openai", "google"] as const;
export type RoleProviderName = (typeof PROVIDER_NAMES)[number];

/** A fully resolved routing target: model id + optional provider override. */
export interface RoleTarget {
  readonly model: string;
  /** When absent, the engine's default provider is used. */
  readonly provider?: RoleProviderName;
}

/** What a config may put in a role slot: bare model id or a full target. */
export type RoleSpec = string | RoleTarget;

/**
 * Partial mapping of role → model spec. Roles not listed fall back to the
 * config's default `model` field.
 */
export type RoleModelMap = Readonly<Partial<Record<Role, RoleSpec>>>;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const roleSpecSchema = z.union([
  z.string().min(1),
  z
    .object({
      model: z.string().min(1),
      provider: z.enum(PROVIDER_NAMES).optional(),
    })
    .strict(),
]);

/**
 * Zod schema for `RoleModelMap`. All fields are optional; each value, when
 * present, is a non-empty model id or a {provider, model} target.
 */
export const roleModelMapSchema: z.ZodType<RoleModelMap> = z
  .object({
    architect: roleSpecSchema.optional(),
    editor: roleSpecSchema.optional(),
    subagent: roleSpecSchema.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/** Normalise a spec to a target. */
function toTarget(spec: RoleSpec): RoleTarget {
  return typeof spec === "string" ? { model: spec } : spec;
}

/** Stable dedupe key: same model on different providers is a distinct target. */
function targetKey(t: RoleTarget): string {
  return `${t.provider ?? ""}:${t.model}`;
}

/**
 * Return the routing target for a given role.
 *
 * Precedence: role's entry in `map` → `fallbackModel` (on the default provider).
 * Deterministic; never throws.
 */
export function resolveRole(map: RoleModelMap, role: Role, fallbackModel: string): RoleTarget {
  const spec = map[role];
  return spec === undefined ? { model: fallbackModel } : toTarget(spec);
}

/**
 * Build an ordered, de-duplicated fallback chain for retry escalation.
 *
 * Order:
 *   1. The primary/resolved target (from `resolveRole(map, role, primary)`
 *      when `role` is supplied, otherwise `primary` on the default provider).
 *   2. Every other distinct target found in `map`, in key-insertion order
 *      (architect → editor → subagent), skipping the head.
 *
 * No duplicates; the head is always first. The chain lets `chatWithRetry`
 * advance to the next target on a retryable `ProviderError` instead of
 * retrying the same overloaded model indefinitely — including across
 * providers when a role names one explicitly.
 */
export function fallbackChain(
  primary: string,
  map: RoleModelMap,
  role?: Role,
): readonly RoleTarget[] {
  const head = role !== undefined ? resolveRole(map, role, primary) : { model: primary };

  const seen = new Set<string>([targetKey(head)]);
  const chain: RoleTarget[] = [head];

  // Append other mapped targets in stable (declaration) order.
  const roles: readonly Role[] = ["architect", "editor", "subagent"];
  for (const r of roles) {
    const spec = map[r];
    if (spec === undefined) continue;
    const target = toTarget(spec);
    if (!seen.has(targetKey(target))) {
      seen.add(targetKey(target));
      chain.push(target);
    }
  }

  return chain;
}
