import { z } from "zod";
import { buildTool } from "./types.js";
import type { ToolUseContext, ToolResult } from "./types.js";
import { createTask } from "../tasks/store.js";

const inputSchema = z.object({
  subject: z.string().describe("Brief title for the task"),
  description: z.string().describe("Detailed description of what needs to be done"),
});

export const taskCreateTool = buildTool({
  name: "task_create",
  description: "Create a new task to track work",
  inputSchema,
  call: async (input, _context): Promise<ToolResult<string>> => {
    const task = createTask(input.subject, input.description);
    return { content: `Created task #${task.id}: ${task.subject}` };
  },
});
