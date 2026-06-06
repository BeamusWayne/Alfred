/**
 * Role-based model routing for Alfred's architect/editor/subagent split.
 *
 * ADR 0005: A strong reasoning model plans (architect), a fast cheap model
 * applies edits (editor), and a subagent handles delegated subtasks. Routing
 * is deterministic and config-driven; no model decisions here.
 *
 * SEAM NOTE: Each role slot currently resolves to a bare model id string.
 * When multi-provider support lands, these slots will resolve to
 * `{ provider: ProviderName; model: string }` so the engine can pick the
 * correct provider instance alongside the model. The `RoleModelMap` type and
 * `resolveRole` signature will remain stable — only the return shape widens.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Role = "architect" | "editor" | "subagent";

/**
 * Partial mapping of role → model id. Roles not listed fall back to the
 * config's default `model` field.
 */
export type RoleModelMap = Readonly<Partial<Record<Role, string>>>;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Zod schema for `RoleModelMap`. All fields are optional; each value, when
 * present, must be a non-empty string (a model id).
 */
export const roleModelMapSchema: z.ZodType<RoleModelMap> = z
  .object({
    architect: z.string().min(1).optional(),
    editor: z.string().min(1).optional(),
    subagent: z.string().min(1).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Return the model id to use for a given role.
 *
 * Precedence: role's entry in `map` → `fallbackModel`.
 * Deterministic; never throws.
 */
export function resolveRole(
  map: RoleModelMap,
  role: Role,
  fallbackModel: string,
): { readonly model: string } {
  const model = map[role] ?? fallbackModel;
  return { model };
}

/**
 * Build an ordered, de-duplicated fallback chain for retry escalation.
 *
 * Order:
 *   1. The primary/resolved model (from `resolveRole(map, role, primary)` when
 *      `role` is supplied, otherwise `primary` itself).
 *   2. Every other distinct model found in `map`, in key-insertion order
 *      (architect → editor → subagent), skipping the primary.
 *
 * No duplicates; primary is always first. The chain lets `chatWithRetry` in
 * the engine advance to the next model on a retryable `ProviderError` instead
 * of retrying the same overloaded model indefinitely.
 *
 * @param primary   Default / global model id (the `config.model` value).
 * @param map       Role-to-model mapping from config.
 * @param role      When supplied, the resolved model for this role becomes the
 *                  head of the chain (may differ from `primary`).
 */
export function fallbackChain(
  primary: string,
  map: RoleModelMap,
  role?: Role,
): readonly string[] {
  const head = role !== undefined ? resolveRole(map, role, primary).model : primary;

  const seen = new Set<string>([head]);
  const chain: string[] = [head];

  // Append other mapped models in stable (declaration) order.
  const roles: readonly Role[] = ["architect", "editor", "subagent"];
  for (const r of roles) {
    const m = map[r];
    if (m !== undefined && !seen.has(m)) {
      seen.add(m);
      chain.push(m);
    }
  }

  return chain;
}
