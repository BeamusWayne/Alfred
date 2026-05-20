import { z } from "zod";
import { buildTool } from "./types.js";
import type { ToolUseContext, ToolResult } from "./types.js";
import { getSkill } from "../skills/store.js";

const inputSchema = z.object({
  name: z.string().describe("Name of the skill to execute"),
  args: z.string().describe("Arguments to pass to the skill").default(""),
});

export const skillTool = buildTool({
  name: "skill",
  description: "Execute a registered skill by name with optional arguments",
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  call: async (input, _context): Promise<ToolResult<string>> => {
    const skill = getSkill(input.name);
    if (!skill) {
      return { content: `Skill '${input.name}' not found`, isError: true };
    }
    const resolved = skill.content.replace(/\{\{args\}\}/g, input.args);
    return { content: resolved };
  },
});
