/**
 * runAgent native structured-output path: on models whose catalog profile
 * enforces a JSON-schema response format, schema runs skip the synthetic
 * structured_output tool and constrain the response directly. Models without
 * support (and strict-unsafe schemas) keep the synthetic-tool path.
 */
import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { runAgent } from "../src/orchestrator/agent.ts";
import { MockProvider, textResponse, toolUseResponse } from "../src/providers/mock.ts";
import type { ToolPermissionContext } from "../src/permissions/types.ts";

const PERMS: ToolPermissionContext = {
  mode: "bypass",
  allowedTools: new Set(),
  deniedTools: new Set(),
  workingDir: "/tmp",
};

const schema = z.object({ answer: z.string() });

describe("runAgent — native structured outputs", () => {
  test("supporting model: no synthetic tool, responseSchema sent, JSON text parsed", async () => {
    const provider = new MockProvider([textResponse('{"answer":"42"}')]);
    const run = await runAgent<{ answer: string }>("q", {
      provider,
      model: "claude-fable-5",
      schema,
      permissions: PERMS,
    });
    expect(run.data).toEqual({ answer: "42" });
    expect(provider.toolNames[0]).toEqual([]); // no structured_output tool
    const sent = provider.configs[0]?.responseSchema;
    expect(sent).toBeDefined();
    expect(sent?.additionalProperties).toBe(false);
  });

  test("non-supporting model keeps the synthetic tool path", async () => {
    const provider = new MockProvider([
      toolUseResponse("structured_output", { answer: "via tool" }),
      textResponse("done"),
    ]);
    const run = await runAgent<{ answer: string }>("q", {
      provider,
      model: "glm-4.6",
      schema,
      permissions: PERMS,
    });
    expect(run.data).toEqual({ answer: "via tool" });
    expect(provider.toolNames[0]).toEqual(["structured_output"]);
    expect(provider.configs[0]?.responseSchema).toBeUndefined();
  });

  test("strict-unsafe schema (optional field) falls back to the synthetic tool", async () => {
    const loose = z.object({ a: z.string(), b: z.number().optional() });
    const provider = new MockProvider([
      toolUseResponse("structured_output", { a: "x" }),
      textResponse("done"),
    ]);
    const run = await runAgent<{ a: string }>("q", {
      provider,
      model: "claude-fable-5",
      schema: loose,
      permissions: PERMS,
    });
    expect(run.data).toEqual({ a: "x" });
    expect(provider.toolNames[0]).toEqual(["structured_output"]);
  });
});
