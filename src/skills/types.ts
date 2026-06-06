/**
 * Skill type contracts + Zod schemas for the 3-level procedural-memory system.
 *
 * Level 1 — always-loaded index: `SkillMeta` (name + description) injected as
 *   a compact `## Available skills` block into every system prompt.
 * Level 2 — on-demand body: `Skill` (meta + full SKILL.md markdown body),
 *   fetched by the `load_skill` tool only when the model requests it.
 * Level 3 — bundled resources: files referenced inside the skill body,
 *   addressable relative to the skill directory.
 *
 * ADR 0001 §7.6 (3-level skills = procedural memory, progressive disclosure).
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Frontmatter schema — subset understood by the loader
// ---------------------------------------------------------------------------

/**
 * Required fields in SKILL.md frontmatter.
 * We intentionally reject missing/blank values early so malformed skills are
 * skipped rather than surfaced with empty metadata.
 */
export const SkillFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/**
 * Level-1 metadata: cheap to keep in memory for all known skills.
 * `path` is the absolute path to the SKILL.md file (not the directory).
 */
export interface SkillMeta {
  readonly name: string;
  readonly description: string;
  readonly path: string;
}

/**
 * Level-2 full skill: the meta plus the entire SKILL.md body (below the
 * frontmatter delimiter).  Loaded only when the model explicitly requests it
 * via the `load_skill` tool.
 */
export interface Skill {
  readonly meta: SkillMeta;
  readonly body: string;
}
