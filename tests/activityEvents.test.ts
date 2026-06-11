/**
 * Tests for live activity events — the data feed behind `alfred watch`'s
 * live panel: `runAgent.onEvent` forwards engine events as they happen, and
 * the runtime journals tool-level "activity" rows in real time. Resume
 * (`findByKey`) must remain blind to them.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runAgent } from "../src/orchestrator/agent.ts";
import { Journal } from "../src/orchestrator/journal.ts";
import { type AgentActivity, createRuntime } from "../src/orchestrator/runtime.ts";
import type { ToolPermissionContext } from "../src/permissions/types.ts";
import { allow } from "../src/permissions/types.ts";
import { MockProvider, textResponse, toolUseResponse } from "../src/providers/mock.ts";
import { buildTool } from "../src/tools/types.ts";

const permissions: ToolPermissionContext = {
  mode: "bypass",
  allowedTools: new Set(),
  deniedTools: new Set(),
  workingDir: "/tmp",
};

const echo = buildTool({
  name: "echo",
  description: "Echo.",
  inputSchema: z.object({}),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  checkPermissions: async () => allow(),
  describeCall: () => "echo()",
  call: async () => ({ content: "ok" }),
});

describe("runAgent — onEvent", () => {
  test("forwards engine events as they happen", async () => {
    const provider = new MockProvider([toolUseResponse("echo", {}), textResponse("done")]);
    const types: string[] = [];

    await runAgent("go", {
      provider,
      model: "mock",
      permissions,
      tools: [echo],
      onEvent: (ev) => types.push(ev.type),
    });

    expect(types).toContain("tool_use");
    expect(types).toContain("tool_result");
    expect(types).toContain("done");
  });
});

describe("runtime — activity journal rows", () => {
  test("tool activity lands in the journal before the agent row, and resume ignores it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alfred-activity-"));
    const journal = new Journal(join(dir, "journal.jsonl"));
    const provider = new MockProvider([toolUseResponse("echo", {}), textResponse("done")]);
    const seen: AgentActivity[] = [];

    const rt = createRuntime("r1", {
      provider,
      model: "mock",
      permissions,
      journal,
      onActivity: (a) => seen.push(a),
    });
    await rt.agent("go", { tools: [echo], label: "implement:f1#1", key: "step-1" });

    // Live callback saw the tool call and its result, tagged with the label.
    expect(seen.some((a) => a.event === "tool_use" && a.describe === "echo()")).toBe(true);
    expect(seen.some((a) => a.event === "tool_result" && a.isError === false)).toBe(true);
    expect(seen.every((a) => a.label === "implement:f1#1")).toBe(true);

    // The journal holds activity rows BEFORE the agent completion row.
    const entries = await journal.readAll();
    const kinds = entries.map((e) => e.type);
    expect(kinds.filter((k) => k === "activity").length).toBeGreaterThanOrEqual(2);
    expect(kinds.indexOf("activity")).toBeLessThan(kinds.indexOf("agent"));

    // Resume by key still returns the agent row, never an activity row.
    const cached = await journal.findByKey("step-1");
    expect(cached?.type).toBe("agent");
  });

  test("activity rows never store tool input or output payloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alfred-activity-"));
    const journal = new Journal(join(dir, "journal.jsonl"));
    const provider = new MockProvider([
      toolUseResponse("echo", { secretish: "do-not-persist" }),
      textResponse("done"),
    ]);

    const rt = createRuntime("r1", { provider, model: "mock", permissions, journal });
    await rt.agent("go", { tools: [echo] });

    const raw = JSON.stringify(await journal.readAll());
    expect(raw).not.toContain("do-not-persist");
    expect(raw).not.toContain('"ok"'); // the tool's output stays out too
  });
});
