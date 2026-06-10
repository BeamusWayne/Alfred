/**
 * spawn_subagent — model-initiated delegation to an isolated sub-agent.
 *
 * The big-codebase lever: bulk reading and parallel exploration happen in a
 * throwaway context window; only the conclusion returns to the parent
 * transcript. Execution is provided by the engine via `ctx.spawnSubagent`
 * (a closure, so this module never imports the engine — no import cycle),
 * which routes to the `subagent` role target, caps nesting at depth 1, and
 * folds the sub-run's usage/cost into the parent run.
 *
 * `read_only: true` marks the call parallel-safe (the engine dispatches
 * read-only+concurrency-safe tool calls concurrently) and restricts the
 * sub-agent to non-mutating tools.
 */
import { z } from "zod";
import { allow } from "../permissions/types.ts";
import { buildTool } from "./types.ts";

const inputSchema = z.object({
  task: z
    .string()
    .min(1)
    .describe(
      "The COMPLETE task specification. The sub-agent shares NO conversation " +
        "context — include relevant file paths, constraints, and exactly what " +
        "to return as the final answer.",
    ),
  read_only: z
    .boolean()
    .optional()
    .describe(
      "true = exploration only (read/search/web tools, no edits). " +
        "Read-only sub-agents issued in the same turn run in parallel.",
    ),
});

/** Tool names a read-only sub-agent may use (non-mutating surface). */
export const READONLY_SUBAGENT_TOOLS: ReadonlySet<string> = new Set([
  "file_read",
  "glob",
  "grep",
  "web_fetch",
  "memory_search",
  "load_skill",
  "lsp_definition",
  "lsp_hover",
  "lsp_references",
]);

export const spawnSubagentTool = buildTool({
  name: "spawn_subagent",
  description:
    "Delegate a self-contained subtask to an isolated sub-agent and get back only its " +
    "final answer. Call this when work fans out across many files or items, when you must " +
    "read a large amount of code but only need the conclusion, or when independent subtasks " +
    "can proceed in parallel (issue several read_only calls in one turn). Do NOT spawn one " +
    "for work you can do directly in one or two tool calls. The sub-agent starts with zero " +
    "context: spell out the full task and the exact shape of the answer you need.",
  inputSchema,
  isReadOnly: (input) => input.read_only === true,
  isConcurrencySafe: (input) => input.read_only === true,
  checkPermissions: async () => allow(),
  describeCall: (input) =>
    `subagent(${input.read_only ? "read-only, " : ""}${input.task.slice(0, 80)}${input.task.length > 80 ? "…" : ""})`,
  call: async (input, ctx) => {
    if (!ctx.spawnSubagent) {
      return {
        content: "Sub-agent nesting is not allowed (depth limit reached). Do the work directly.",
        isError: true,
      };
    }
    const result = await ctx.spawnSubagent(input.task, { readOnly: input.read_only === true });
    if (result.status !== "success") {
      return {
        content: `Sub-agent ended with status "${result.status}" after ${result.turns} turns.\n${result.text}`,
        isError: true,
      };
    }
    return {
      content: result.text.length > 0 ? result.text : "(sub-agent finished without a text answer)",
    };
  },
});
