import { z } from "zod";
import { buildTool } from "./types.js";
import type { ToolUseContext, ToolResult } from "./types.js";

const inputSchema = z.object({
  prompt: z.string().describe("The task description for the sub-agent"),
  model: z.string().optional().describe("Model override for the sub-agent"),
});

export const agentTool = buildTool({
  name: "agent",
  description: "Launch a sub-agent to handle a specific task independently",
  inputSchema,
  call: async (input, _context): Promise<ToolResult<string>> => {
    return {
      content: `Sub-agent task: "${input.prompt}". Sub-agent execution requires the full agent loop to be connected.`,
    };
  },
});
