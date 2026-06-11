/**
 * Tests for src/orchestrator/agent.ts — the structured sub-agent primitive.
 *
 * Three paths are exercised (ADR 0001 §5):
 *  1. schema path — model calls `structured_output` tool → data is captured
 *  2. text fallback path — model ignores the tool, returns JSON text → data
 *     is parsed from that text
 *  3. no-schema path — plain text response, data is null
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { runAgent } from "../src/orchestrator/agent.ts";
import type { ToolPermissionContext } from "../src/permissions/types.ts";
import { MockProvider, textResponse, toolUseResponse } from "../src/providers/mock.ts";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const permissions: ToolPermissionContext = {
  mode: "bypass",
  allowedTools: new Set(),
  deniedTools: new Set(),
  workingDir: "/tmp",
};

function makeOpts(provider: MockProvider, extra: { schema?: z.ZodTypeAny } = {}) {
  return {
    provider,
    model: "mock",
    permissions,
    maxTurns: 10,
    ...extra,
  };
}

const answerSchema = z.object({
  answer: z.string(),
  confidence: z.number().min(0).max(1),
});

// ---------------------------------------------------------------------------
// Schema path: model calls the structured_output tool
// ---------------------------------------------------------------------------

describe("runAgent — schema path (tool call)", () => {
  test("data matches the object passed to structured_output", async () => {
    const payload = { answer: "42", confidence: 0.99 };

    // Turn 1: model calls structured_output.
    // Turn 2: after tool result, engine sees end_turn → done.
    const provider = new MockProvider([
      toolUseResponse("structured_output", payload),
      textResponse("done"),
    ]);

    const run = await runAgent<z.infer<typeof answerSchema>>("What is the answer?", {
      ...makeOpts(provider, { schema: answerSchema }),
    });

    expect(run.data).toEqual(payload);
    expect(run.data?.answer).toBe("42");
    expect(run.data?.confidence).toBe(0.99);
    expect(run.status).toBe("success");
  });

  test("cost is populated after a schema run", async () => {
    const payload = { answer: "hello", confidence: 0.5 };
    const provider = new MockProvider([
      toolUseResponse("structured_output", payload),
      textResponse("done"),
    ]);

    const run = await runAgent("prompt", makeOpts(provider, { schema: answerSchema }));

    // cost object must be present (engine populates it even with ZERO_USAGE)
    expect(run.cost).toBeDefined();
    expect(typeof run.cost?.usd).toBe("number");
  });

  test("turns is incremented for each model round-trip", async () => {
    const payload = { answer: "x", confidence: 0.1 };
    const provider = new MockProvider([
      toolUseResponse("structured_output", payload),
      textResponse("done"),
    ]);

    const run = await runAgent("prompt", makeOpts(provider, { schema: answerSchema }));

    // Two provider calls: one for the tool_use, one after the tool result.
    expect(run.turns).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Text fallback path: model ignores the tool, returns JSON text
// ---------------------------------------------------------------------------

describe("runAgent — text fallback (JSON in text)", () => {
  test("data is parsed from JSON text when tool was not called", async () => {
    const payload = { answer: "fallback", confidence: 0.75 };
    // Model returns JSON text directly, no tool_use block.
    const provider = new MockProvider([textResponse(JSON.stringify(payload))]);

    const run = await runAgent<z.infer<typeof answerSchema>>("Q?", {
      ...makeOpts(provider, { schema: answerSchema }),
    });

    expect(run.data).toEqual(payload);
    expect(run.data?.answer).toBe("fallback");
  });

  test("data is null when JSON text does not satisfy the schema", async () => {
    // Missing `confidence` — schema validation should fail.
    const provider = new MockProvider([textResponse(JSON.stringify({ answer: "only" }))]);

    const run = await runAgent("Q?", makeOpts(provider, { schema: answerSchema }));

    expect(run.data).toBeNull();
    expect(run.status).toBe("success");
  });

  test("data is null when text is not JSON", async () => {
    const provider = new MockProvider([textResponse("not json at all")]);

    const run = await runAgent("Q?", makeOpts(provider, { schema: answerSchema }));

    expect(run.data).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// No-schema path: plain text, no structured output
// ---------------------------------------------------------------------------

describe("runAgent — no-schema path", () => {
  test("text equals the assistant message, data is null", async () => {
    const provider = new MockProvider([textResponse("hello")]);

    const run = await runAgent("hi", makeOpts(provider));

    expect(run.text).toBe("hello");
    expect(run.data).toBeNull();
    expect(run.status).toBe("success");
  });

  test("cost is defined", async () => {
    const provider = new MockProvider([textResponse("ok")]);
    const run = await runAgent("hi", makeOpts(provider));
    expect(run.cost).toBeDefined();
  });

  test("turns is at least 1", async () => {
    const provider = new MockProvider([textResponse("ok")]);
    const run = await runAgent("hi", makeOpts(provider));
    expect(run.turns).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Status propagation
// ---------------------------------------------------------------------------

describe("runAgent — status propagation", () => {
  test("status is max_turns when engine hits the turn limit", async () => {
    // Always returns a tool call that the engine cannot find → keeps looping.
    const provider = new MockProvider([() => toolUseResponse("nonexistent_tool", {})]);

    const run = await runAgent("loop", {
      ...makeOpts(provider),
      maxTurns: 2,
    });

    expect(run.status).toBe("max_turns");
    expect(run.turns).toBe(2);
  });
});
