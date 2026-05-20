import { z } from "zod";
import { buildTool } from "./types.js";
import type { ToolUseContext, ToolResult } from "./types.js";
import { updateTask } from "../tasks/store.js";

const inputSchema = z.object({
  id: z.string().describe("Task ID to update"),
  status: z.enum(["pending", "in_progress", "completed"]).optional(),
  subject: z.string().optional(),
  description: z.string().optional(),
});

export const taskUpdateTool = buildTool({
  name: "task_update",
  description: "Update an existing task's status, subject, or description",
  inputSchema,
  call: async (input, _context): Promise<ToolResult<string>> => {
    const updates: Record<string, unknown> = {};
    if (input.status !== undefined) updates.status = input.status;
    if (input.subject !== undefined) updates.subject = input.subject;
    if (input.description !== undefined) updates.description = input.description;

    const task = updateTask(input.id, updates);
    if (!task) return { content: `Task #${input.id} not found`, isError: true };
    return { content: `Updated task #${task.id}: status=${task.status}` };
  },
});
