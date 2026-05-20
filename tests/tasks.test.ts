import { describe, test, expect, beforeEach } from "bun:test";
import { clearTasks } from "../src/tasks/store.js";
import { taskCreateTool } from "../src/tools/taskCreate.js";
import { taskUpdateTool } from "../src/tools/taskUpdate.js";
import { taskListTool } from "../src/tools/taskList.js";

const context = {
  abortController: new AbortController(),
  workingDir: "/tmp",
  readFileState: new Map(),
  permissionContext: {
    mode: "bypass" as const,
    allowedTools: new Set(),
    deniedTools: new Set(),
    workingDir: "/tmp",
  },
};

beforeEach(() => { clearTasks(); });

describe("task tools", () => {
  test("create a task", async () => {
    const result = await taskCreateTool.call({ subject: "Fix auth bug", description: "Login fails on Safari" }, context);
    expect(result.content).toContain("Created task #1");
  });

  test("list tasks", async () => {
    await taskCreateTool.call({ subject: "Task A", description: "Do A" }, context);
    await taskCreateTool.call({ subject: "Task B", description: "Do B" }, context);
    const result = await taskListTool.call({}, context);
    expect(result.content).toContain("Task A");
    expect(result.content).toContain("Task B");
  });

  test("update task status", async () => {
    await taskCreateTool.call({ subject: "My task", description: "Do stuff" }, context);
    const result = await taskUpdateTool.call({ id: "1", status: "in_progress" }, context);
    expect(result.content).toContain("status=in_progress");
  });

  test("update nonexistent task", async () => {
    const result = await taskUpdateTool.call({ id: "999", status: "completed" }, context);
    expect(result.isError).toBe(true);
  });

  test("empty task list", async () => {
    const result = await taskListTool.call({}, context);
    expect(result.content).toBe("No tasks");
  });

  test("full lifecycle", async () => {
    await taskCreateTool.call({ subject: "Write tests", description: "Add unit tests" }, context);
    await taskUpdateTool.call({ id: "1", status: "in_progress" }, context);
    await taskUpdateTool.call({ id: "1", status: "completed" }, context);
    const result = await taskListTool.call({}, context);
    expect(result.content).toContain("[completed]");
  });
});
