/**
 * Feature-list state machine for Alfred's autonomous harness.
 *
 * ADR 0001 §5.3 / §7.7 (feature_list state machine)
 *
 * The harness is a deterministic state machine over `feature_list.json`.
 * Control flow is CODE, not model-decided (ADR 0001 P3): pick the next
 * actionable feature by priority / deps, run it, then mark it `passing`
 * (only with a captured verify exit 0) or `blocked`.
 *
 * All transition functions return a NEW FeatureList — originals are never
 * mutated.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FeatureStatus = "pending" | "in_progress" | "passing" | "blocked";

export interface Feature {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: FeatureStatus;
  readonly priority?: number | undefined;
  readonly iterationBudget?: number | undefined;
  readonly deps?: readonly string[] | undefined;
}

export interface FeatureList {
  readonly features: readonly Feature[];
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const featureStatusSchema = z.enum(["pending", "in_progress", "passing", "blocked"]);

const featureSchema: z.ZodType<Feature> = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  status: featureStatusSchema,
  priority: z.number().optional(),
  iterationBudget: z.number().int().positive().optional(),
  deps: z.array(z.string()).readonly().optional(),
});

export const featureListSchema: z.ZodType<FeatureList> = z.object({
  features: z.array(featureSchema).readonly(),
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Returns true when no feature is `pending` or `in_progress`.
 */
export function allResolved(list: FeatureList): boolean {
  return list.features.every(
    (f) => f.status !== "pending" && f.status !== "in_progress",
  );
}

/**
 * Count of features in each status bucket.
 */
export function counts(list: FeatureList): Record<FeatureStatus, number> {
  const result: Record<FeatureStatus, number> = {
    pending: 0,
    in_progress: 0,
    passing: 0,
    blocked: 0,
  };
  for (const f of list.features) {
    result[f.status] += 1;
  }
  return result;
}

// ---------------------------------------------------------------------------
// pickNext
// ---------------------------------------------------------------------------

/**
 * Pick the next actionable feature:
 * - status must be `pending`
 * - all declared `deps` must themselves be `passing`
 * - lowest `priority` number wins; features without `priority` sort last
 * - ties broken by original array order (stable)
 *
 * Returns `null` when no eligible feature exists.
 */
export function pickNext(list: FeatureList): Feature | null {
  const passingIds = new Set(
    list.features.filter((f) => f.status === "passing").map((f) => f.id),
  );

  const eligible = list.features.filter((f) => {
    if (f.status !== "pending") return false;
    if (f.deps === undefined || f.deps.length === 0) return true;
    return f.deps.every((dep) => passingIds.has(dep));
  });

  if (eligible.length === 0) return null;

  // Sort: features with a priority number first (ascending), then those
  // without priority, preserving array order within each tier.
  const sorted = eligible.slice().sort((a, b) => {
    const aPri = a.priority;
    const bPri = b.priority;
    if (aPri !== undefined && bPri !== undefined) return aPri - bPri;
    if (aPri !== undefined) return -1; // a has priority, b does not → a first
    if (bPri !== undefined) return 1; // b has priority, a does not → b first
    return 0; // both undefined → preserve original order (sort is stable in V8/Bun)
  });

  return sorted[0] ?? null;
}

// ---------------------------------------------------------------------------
// Transitions — all return a NEW FeatureList
// ---------------------------------------------------------------------------

/**
 * Return a new FeatureList with the feature identified by `id` set to `status`.
 * Throws when no feature with that id exists.
 */
export function setStatus(
  list: FeatureList,
  id: string,
  status: FeatureStatus,
): FeatureList {
  let found = false;
  const features = list.features.map((f) => {
    if (f.id !== id) return f;
    found = true;
    return { ...f, status } satisfies Feature;
  });
  if (!found) {
    throw new Error(`featureList.setStatus: no feature with id "${id}"`);
  }
  return { ...list, features };
}

/** Mark a feature as `in_progress`. */
export function markInProgress(list: FeatureList, id: string): FeatureList {
  return setStatus(list, id, "in_progress");
}

/** Mark a feature as `passing` (only call after a verify exit 0). */
export function markPassing(list: FeatureList, id: string): FeatureList {
  return setStatus(list, id, "passing");
}

/** Mark a feature as `blocked` (iteration budget exhausted or unrecoverable). */
export function markBlocked(list: FeatureList, id: string): FeatureList {
  return setStatus(list, id, "blocked");
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

/**
 * Load and validate a feature list from a JSON file at `path`.
 * Throws a descriptive error when the file is missing, unparseable, or
 * fails schema validation.
 */
export async function loadFeatureList(path: string): Promise<FeatureList> {
  const file = Bun.file(path);
  const exists = await file.exists();
  if (!exists) {
    throw new Error(`loadFeatureList: file not found: "${path}"`);
  }

  let raw: unknown;
  try {
    raw = await file.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`loadFeatureList: invalid JSON in "${path}": ${msg}`);
  }

  const result = featureListSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `loadFeatureList: schema validation failed for "${path}":\n${issues}`,
    );
  }

  return result.data;
}

/**
 * Persist a feature list to `path` as pretty-printed JSON.
 * The file is created or overwritten atomically via `Bun.write`.
 */
export async function saveFeatureList(
  path: string,
  list: FeatureList,
): Promise<void> {
  await Bun.write(path, JSON.stringify(list, null, 2) + "\n");
}
