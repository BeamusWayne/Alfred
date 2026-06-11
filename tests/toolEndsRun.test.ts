/**
 * Tests for `ToolResult.endsRun` — a tool's successful result may declare the
 * run complete: the engine records the current tool batch, then ends with
 * status "success" instead of asking the model for another turn.
 *
 * Primary consumer: the synthetic `structured_output` tool. Observed live
 * (glm-4.7 rubric judge): the verdict was captured on an early turn, yet the
 * model wandered on to max_turns — 50 turns and 30x the implement cost for a
 * judgement that was already in hand.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { runAgent } from "../src/orchestrator/agent.ts";
import type { ToolPermissionContext } from "../src/permissions/types.ts";
import { allow } from "../src/permissions/types.ts";
import { MockProvider, textResponse, toolUseResponse } from "../src/providers/mock.ts";
import { runQuery } from "../src/query/engine.ts";
import type { QueryEvent, QueryState } from "../src/query/types.ts";
import { buildTool } from "../src/tools/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const permissions: ToolPermissionContext = {
  mode: "bypass",
  allowedTools: new Set(),
  deniedTools: new Set(),
  workingDir: "/tmp",
};

async function collect(
  gen: AsyncGenerator<QueryEvent, QueryState>,
): Promise<{ events: QueryEvent[]; state: QueryState }> {
  const events: QueryEvent[] = [];
  let r = await gen.next();
  while (!r.done) {
    events.push(r.value);
    r = await gen.next();
  }
  return { events, state: r.value };
}

const finishNow = buildTool({
  name: "finish_now",
  description: "Declares the run complete.",
  inputSchema: z.object({}),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  checkPermissions: async () => allow(),
  describeCall: () => "finish_now",
  call: async () => ({ content: "done", endsRun: true }),
});

const failingFinish = buildTool({
  name: "failing_finish",
  description: "Errors while asking to end the run — must NOT end it.",
  inputSchema: z.object({}),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  checkPermissions: async () => allow(),
  describeCall: () => "failing_finish",
  call: async () => ({ content: "boom", isError: true, endsRun: true }),
});

const answerSchema = z.object({
  answer: z.string(),
  confidence: z.number().min(0).max(1),
});

// ---------------------------------------------------------------------------
// Engine primitive
// ---------------------------------------------------------------------------

describe("engine — ToolResult.endsRun", () => {
  test("ends the run with success after the tool batch is recorded", async () => {
    const provider = new MockProvider([
      toolUseResponse("finish_now", {}),
      textResponse("UNREACHED — the run must end before this is consumed"),
    ]);
    const { events, state } = await collect(
      runQuery("go", { provider, model: "mock", permissions, tools: [finishNow] }),
    );

    expect(state.status).toBe("success");
    expect(state.turns).toBe(1);
    // The tool result is still appended before the run ends — the transcript
    // stays provider-valid (every tool_use has its tool_result).
    expect(state.messages.at(-1)?.role).toBe("tool_result");
    expect(events.some((e) => e.type === "done" && e.status === "success")).toBe(true);
  });

  test("an erroring tool cannot end the run", async () => {
    const provider = new MockProvider([
      toolUseResponse("failing_finish", {}),
      textResponse("recovered"),
    ]);
    const { state } = await collect(
      runQuery("go", { provider, model: "mock", permissions, tools: [failingFinish] }),
    );

    // The error went back to the model, which answered normally on turn 2.
    expect(state.status).toBe("success");
    expect(state.turns).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// structured_output wiring (the live 50-turn burn, reduced to a script)
// ---------------------------------------------------------------------------

describe("runAgent — schema run ends when the verdict lands", () => {
  test("one turn: valid structured_output stops the run immediately", async () => {
    const payload = { answer: "42", confidence: 0.99 };
    const provider = new MockProvider([
      toolUseResponse("structured_output", payload),
      textResponse("UNREACHED — yesterday this wandering turn was consumed"),
    ]);

    const run = await runAgent<z.infer<typeof answerSchema>>("judge it", {
      provider,
      model: "mock",
      permissions,
      maxTurns: 10,
      schema: answerSchema,
    });

    expect(run.status).toBe("success");
    expect(run.turns).toBe(1);
    expect(run.data).toEqual(payload);
  });

  test("an invalid payload keeps the loop alive until a valid one lands", async () => {
    const payload = { answer: "ok", confidence: 0.5 };
    const provider = new MockProvider([
      toolUseResponse("structured_output", { wrong: "shape" }),
      toolUseResponse("structured_output", payload),
      textResponse("UNREACHED"),
    ]);

    const run = await runAgent<z.infer<typeof answerSchema>>("judge it", {
      provider,
      model: "mock",
      permissions,
      maxTurns: 10,
      schema: answerSchema,
    });

    expect(run.status).toBe("success");
    expect(run.turns).toBe(2);
    expect(run.data).toEqual(payload);
  });
});
