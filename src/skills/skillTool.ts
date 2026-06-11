/**
 * `load_skill` tool — Level-2 on-demand skill body loader.
 *
 * The model holds only the Level-1 index (name + description) in its context.
 * When it needs the full procedural instructions for a skill it calls this tool
 * with `{ name }`.  The tool reads and returns the SKILL.md body so the context
 * window is not pre-loaded with skill bodies the model may never need.
 *
 * Flags: read-only + concurrency-safe — purely a filesystem read with no side
 * effects, so the engine may run it in parallel with other read-only tools.
 *
 * ADR 0001 §7.6 (3-level skills = procedural memory, progressive disclosure).
 */

import { join } from "node:path";
import { z } from "zod";
import { allow } from "../permissions/types.ts";
import type { Tool } from "../tools/types.ts";
import { buildTool } from "../tools/types.ts";
import { loadSkill } from "./loader.ts";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const LoadSkillInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe("The skill name to load (must match a subdirectory in skillsDir)"),
});

type LoadSkillInput = z.infer<typeof LoadSkillInputSchema>;

const DESCRIPTION =
  "Load the full instructions for a named skill (Level-2 procedural memory). " +
  "Use the skill index in the system prompt to find available skill names, " +
  "then call this tool to retrieve the complete skill body before executing the skill.";

// ---------------------------------------------------------------------------
// Factory (bound to an explicit skillsDir)
// ---------------------------------------------------------------------------

/**
 * Build the `load_skill` tool bound to `skillsDir`.
 *
 * @param skillsDir — absolute path to the directory that contains skill
 *   subdirectories (e.g. `<workingDir>/.alfred/skills`).
 */
export function makeSkillTool(skillsDir: string): Tool<typeof LoadSkillInputSchema, string> {
  return buildTool<typeof LoadSkillInputSchema, string>({
    name: "load_skill",
    description: DESCRIPTION,
    inputSchema: LoadSkillInputSchema,
    isReadOnly: (_input: LoadSkillInput) => true,
    isConcurrencySafe: (_input: LoadSkillInput) => true,
    checkPermissions: async (_input: LoadSkillInput) => allow(),
    describeCall: (input: LoadSkillInput) => `load_skill(${input.name})`,
    call: async (input: LoadSkillInput) => {
      const skill = await loadSkill(skillsDir, input.name);
      if (skill === null) {
        return {
          content: `Skill "${input.name}" not found. Check the ## Available skills index for valid names.`,
          isError: true,
        };
      }
      return { content: skill.body };
    },
  });
}

// ---------------------------------------------------------------------------
// Static tool (resolves skillsDir from the call context's workingDir)
// ---------------------------------------------------------------------------

/** The built-in `load_skill` tool, rooted at `<ctx.workingDir>/.alfred/skills`. */
export const skillTool: Tool<typeof LoadSkillInputSchema, string> = buildTool<
  typeof LoadSkillInputSchema,
  string
>({
  name: "load_skill",
  description: DESCRIPTION,
  inputSchema: LoadSkillInputSchema,
  isReadOnly: (_input: LoadSkillInput) => true,
  isConcurrencySafe: (_input: LoadSkillInput) => true,
  checkPermissions: async (_input: LoadSkillInput) => allow(),
  describeCall: (input: LoadSkillInput) => `load_skill(${input.name})`,
  call: async (input: LoadSkillInput, ctx) => {
    const skill = await loadSkill(join(ctx.workingDir, ".alfred", "skills"), input.name);
    if (skill === null) {
      return {
        content: `Skill "${input.name}" not found. Check the ## Available skills index for valid names.`,
        isError: true,
      };
    }
    return { content: skill.body };
  },
});
