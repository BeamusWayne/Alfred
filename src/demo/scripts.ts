/**
 * Scripted model for the built-in offline demo (`alfred demo`) — drives the
 * autonomous harness end-to-end with ZERO API calls. The engine, tools,
 * permission stack, verify gate and signed ledger are all real; only the LLM
 * responses below are recorded. Same Script[] as examples/demo, shipped
 * inside the package so `bunx alfred-agent demo` works without a clone.
 */
import { type Script, textResponse, toolUseResponse } from "../providers/mock.ts";
import type { Message } from "../providers/types.ts";

const ADD_TS = [
  "/** Demo feature: pure addition. */",
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "",
].join("\n");

/** The first user message carries the agent's brief (implement vs rubric). */
function firstUserText(messages: readonly Message[]): string {
  for (const m of messages) {
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    return m.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
  }
  return "";
}

function sawToolResult(messages: readonly Message[]): boolean {
  return messages.some((m) => m.role === "tool_result");
}

/**
 * One function script handles every call (the last script repeats): the brief
 * in the first user message tells us which agent is asking, and the presence
 * of a tool_result tells us whether its tool call already ran.
 */
const demoScript: Script = (messages) => {
  const brief = firstUserText(messages);
  const isRubricJudge = brief.includes("Assess whether the following feature");

  if (isRubricJudge) {
    return sawToolResult(messages)
      ? textResponse("Recorded.")
      : toolUseResponse(
          "structured_output",
          {
            verification: 2,
            reasoning: "add.ts exists and exports add(a, b); the verify gate exited 0.",
          },
          { text: "Inspecting the working tree…" },
        );
  }

  return sawToolResult(messages)
    ? textResponse("add() implemented — the verify gate (bun test) is the sole arbiter.")
    : toolUseResponse(
        "file_write",
        { path: "add.ts", content: ADD_TS },
        { text: "Writing add.ts…" },
      );
};

export const demoScripts: readonly Script[] = [demoScript];
