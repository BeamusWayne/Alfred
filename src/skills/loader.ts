/**
 * Skill discovery + on-demand loading for the 3-level procedural-memory system.
 *
 * `discoverSkills` — Level 1: scan `<skillsDir>/` for subdirectories that each
 *   contain a `SKILL.md` with valid `name` + `description` frontmatter. Cheap
 *   enough to call on every agent start.
 *
 * `loadSkill` — Level 2: read and return the full SKILL.md body for a named
 *   skill. Called only when the model explicitly invokes `load_skill`.
 *
 * `renderSkillIndex` — produce the compact markdown block injected as Level-1
 *   context into `buildSystemPrompt`.
 *
 * ADR 0001 §7.6 (3-level skills = procedural memory, progressive disclosure).
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Skill, SkillMeta } from "./types.ts";
import { SkillFrontmatterSchema } from "./types.ts";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const SKILL_FILENAME = "SKILL.md";

/**
 * Mirror of the minimal `---` frontmatter parser in `src/memory/localFile.ts`.
 * Returns parsed key/value pairs and the body below the closing `---` line.
 * Returns `{ frontmatter: {}, body: raw }` when no frontmatter block is found.
 */
function parseFrontmatter(raw: string): {
  readonly frontmatter: Record<string, string>;
  readonly body: string;
} {
  const delim = "---";
  if (!raw.startsWith(delim)) {
    return { frontmatter: {}, body: raw };
  }
  const end = raw.indexOf("\n---", delim.length);
  if (end === -1) {
    return { frontmatter: {}, body: raw };
  }
  const yamlBlock = raw.slice(delim.length + 1, end).trim();
  const body = raw.slice(end + 4).replace(/^\n/, "");
  const frontmatter: Record<string, string> = {};
  for (const line of yamlBlock.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    if (key) frontmatter[key] = val;
  }
  return { frontmatter, body };
}

async function safeReadText(path: string): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return file.text();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan `skillsDir` for skill subdirectories and return Level-1 metadata for
 * every valid skill found.  A skill is valid when its `SKILL.md` contains
 * a `name` and `description` in the frontmatter.  Malformed or missing files
 * are silently skipped.  A missing `skillsDir` returns an empty array.
 */
export async function discoverSkills(skillsDir: string): Promise<readonly SkillMeta[]> {
  let entries: string[];
  try {
    entries = await readdir(skillsDir, { encoding: "utf-8" });
  } catch {
    // Directory does not exist or is unreadable — graceful degradation.
    return [];
  }

  const metas: SkillMeta[] = [];

  for (const entry of entries) {
    const skillPath = join(skillsDir, entry, SKILL_FILENAME);
    const raw = await safeReadText(skillPath);
    if (raw === null) continue;

    const { frontmatter } = parseFrontmatter(raw);
    const parsed = SkillFrontmatterSchema.safeParse(frontmatter);
    if (!parsed.success) continue;

    metas.push({
      name: parsed.data.name,
      description: parsed.data.description,
      path: skillPath,
    });
  }

  return metas;
}

/**
 * Load the full Level-2 skill body for `name`.  Returns `null` when the skill
 * directory or SKILL.md is absent, or when the frontmatter is invalid.
 */
export async function loadSkill(skillsDir: string, name: string): Promise<Skill | null> {
  const skillPath = join(skillsDir, name, SKILL_FILENAME);
  const raw = await safeReadText(skillPath);
  if (raw === null) return null;

  const { frontmatter, body } = parseFrontmatter(raw);
  const parsed = SkillFrontmatterSchema.safeParse(frontmatter);
  if (!parsed.success) return null;

  const meta: SkillMeta = {
    name: parsed.data.name,
    description: parsed.data.description,
    path: skillPath,
  };

  return { meta, body };
}

/**
 * Render a compact `## Available skills` markdown block for Level-1 injection
 * into the system prompt.  Each skill is one line: `- **name** — description`.
 * An empty `metas` array renders a note indicating no skills are available.
 */
export function renderSkillIndex(metas: readonly SkillMeta[]): string {
  if (metas.length === 0) {
    return "## Available skills\n\n_No skills available._\n";
  }

  const lines = metas.map((m) => `- **${m.name}** — ${m.description}`);
  return `## Available skills\n\n${lines.join("\n")}\n`;
}
