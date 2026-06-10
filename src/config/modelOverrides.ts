/**
 * `.alfred/models.json` — user-extensible model capability catalog.
 *
 * Lets an operator teach Alfred about a model the built-in catalog doesn't
 * know (a brand-new release, an internal deployment, a proxy alias) without
 * forking: entries are keyed by model-id prefix and may set any subset of
 * the profile fields; the rest falls back to the built-in entry with the
 * same key, else the conservative default.
 *
 *   { "gemini-3.1-pro": { "contextWindow": 1000000, "maxOutput": 65536,
 *     "supportsEffort": true, "tier": "frontier" } }
 *
 * Loading is best-effort and validated: a malformed file warns and is
 * ignored — it must never take the CLI down.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { registerModelOverrides, type ModelProfile } from "./modelCatalog.ts";

const partialProfileSchema = z
  .object({
    contextWindow: z.number().int().positive().optional(),
    maxOutput: z.number().int().positive().optional(),
    thinking: z.enum(["adaptive", "budget", "none"]).optional(),
    supportsTemperature: z.boolean().optional(),
    supportsEffort: z.boolean().optional(),
    supportsTaskBudget: z.boolean().optional(),
    supportsStructuredOutput: z.boolean().optional(),
    supportsServerCompaction: z.boolean().optional(),
    tier: z.enum(["frontier", "strong", "small"]).optional(),
  })
  .strict();

export const modelOverridesSchema = z.record(z.string().min(1), partialProfileSchema);

/**
 * Load `.alfred/models.json` from `dir` into the catalog. Missing file is a
 * no-op; an invalid file warns via `onWarn` and changes nothing.
 */
export function loadModelOverrides(dir: string, onWarn?: (message: string) => void): void {
  const path = join(dir, ".alfred", "models.json");
  if (!existsSync(path)) return;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    const parsed = modelOverridesSchema.parse(raw);
    registerModelOverrides(parsed as Readonly<Record<string, Partial<ModelProfile>>>);
  } catch (err) {
    onWarn?.(`ignoring invalid ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
