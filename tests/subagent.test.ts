/**
 * spawn_subagent — model-initiated delegation with depth cap 1.
 *
 * Contract under test:
 *   - the parent's tool call runs an isolated sub-run whose final text comes
 *     back as the tool result;
 *   - the sub-agent NEVER sees spawn_subagent (no recursion);
 *   - read_only sub-agents get only the non-mutating tool surface;
 *   - sub-run usage folds into the parent run's usage;
 *   - the sub-run rides the `subagent` role (cheap model + low effort).
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runQuery } from "../src/query/engine.ts";
import type { QueryConfig, QueryEvent, QueryState } from "../src/query/types.ts";
import { MockProvider, textResponse, toolUseResponse } from "../src/providers/mock.ts";
import { ZERO_USAGE, type LLMResponse, type Provider } from "../src/providers/types.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "alfred-sub-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function config(provider: Provider, over: Partial<QueryConfig> = {}): QueryConfig {
  return {
    provider,
    model: "mock-main",
    permissions: {
      mode: "bypass",
      allowedTools: new Set(),
      deniedTools: new Set(),
      workingDir: dir,
    },
    ...over,
  };
}

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

function spawnCall(task: string, readOnly?: boolean): LLMResponse {
  return toolUseResponse("spawn_subagent", {
    task,
    ...(readOnly !== undefined ? { read_only: readOnly } : {}),
  });
}

describe("spawn_subagent", () => {
  test("delegates, returns the sub-agent's final text, and completes", async () => {
    const provider = new MockProvider([
      spawnCall("count the widgets"),
      textResponse("There are 42 widgets."),
      textResponse("parent done"),
    ]);
    const { events, state } = await collect(runQuery("go", config(provider)));
    expect(state.status).toBe("success");
    const result = events.find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ isError: false });
    expect(result && "output" in result ? result.output : "").toContain("42 widgets");
    // The sub-run's first user message is the task spec, verbatim.
    expect(provider.calls[1]?.[0]).toEqual({ role: "user", content: "count the widgets" });
  });

  test("the sub-agent never sees spawn_subagent (depth cap)", async () => {
    const provider = new MockProvider([
      spawnCall("explore"),
      textResponse("explored"),
      textResponse("done"),
    ]);
    await collect(runQuery("go", config(provider)));
    expect(provider.toolNames[0]).toContain("spawn_subagent");
    expect(provider.toolNames[1]).not.toContain("spawn_subagent");
  });

  test("read_only sub-agents get only the non-mutating tool surface", async () => {
    const provider = new MockProvider([
      spawnCall("scan the repo", true),
      textResponse("scanned"),
      textResponse("done"),
    ]);
    await collect(runQuery("go", config(provider)));
    const subTools = provider.toolNames[1] ?? [];
    expect(subTools).toContain("file_read");
    expect(subTools).toContain("grep");
    expect(subTools).not.toContain("bash");
    expect(subTools).not.toContain("file_write");
    expect(subTools).not.toContain("file_edit");
  });

  test("sub-run usage folds into the parent run", async () => {
    const subUsage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const provider = new MockProvider([
      spawnCall("work"),
      { content: [{ type: "text", text: "sub done" }], stopReason: "end_turn", usage: subUsage, model: "mock-sub" },
      textResponse("parent done"),
    ]);
    const { state } = await collect(runQuery("go", config(provider)));
    expect(state.usage.inputTokens).toBe(100);
    expect(state.usage.outputTokens).toBe(50);
  });

  test("sub-run rides the subagent role target with low effort", async () => {
    const provider = new MockProvider([
      spawnCall("work"),
      textResponse("sub done"),
      textResponse("parent done"),
    ]);
    await collect(
      runQuery("go", config(provider, { roles: { subagent: "mock-cheap" } })),
    );
    expect(provider.configs[1]?.model).toBe("mock-cheap");
    expect(provider.configs[1]?.effort).toBe("low");
  });

  test("a failed sub-run surfaces as a tool error, not silent success", async () => {
    const failing: LLMResponse = {
      content: [],
      stopReason: "max_tokens",
      usage: ZERO_USAGE,
      model: "mock",
    };
    // Sub-agent truncates with empty content 4x -> truncated status.
    const provider = new MockProvider([
      spawnCall("work"),
      failing,
      failing,
      failing,
      failing,
      textResponse("parent recovers"),
    ]);
    const { events, state } = await collect(runQuery("go", config(provider)));
    const result = events.find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ isError: true });
    expect(state.status).toBe("success"); // parent continues after the error result
  });
});
