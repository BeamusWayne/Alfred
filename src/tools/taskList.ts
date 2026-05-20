import { z } from "zod";
import { buildTool } from "./types.js";
import type { ToolUseContext, ToolResult } from "./types.js";
import { listTasks } from "../tasks/store.js";

const inputSchema = z.object({});

export const taskListTool = buildTool({
  name: "task_list",
  description: "List all tasks and their statuses",
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  call: async (_input, _context): Promise<ToolResult<string>> => {
    const tasks = listTasks();
    if (tasks.length === 0) return { content: "No tasks" };
    return { content: tasks.map((t) => `#${t.id} [${t.status}] ${t.subject}`).join("\n") };
  },
});
