import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, textResponse, toolUseResponse } from "../src/providers/mock.ts";
import { type Provider, ProviderError } from "../src/providers/types.ts";
import { runQuery } from "../src/query/engine.ts";
import type { QueryConfig, QueryEvent, QueryState } from "../src/query/types.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "alfred-engine-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function config(
  provider: Provider,
  over: Partial<QueryConfig> & { mode?: QueryConfig["permissions"]["mode"] } = {},
): QueryConfig {
  const { mode, ...rest } = over;
  return {
    provider,
    model: "mock",
    permissions: {
      mode: mode ?? "bypass",
      allowedTools: new Set(),
      deniedTools: new Set(),
      workingDir: dir,
    },
    ...rest,
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

describe("runQuery", () => {
  test("returns text and a success status with no tools", async () => {
    const { events, state } = await collect(
      runQuery("hi", config(new MockProvider([textResponse("hello")]))),
    );
    expect(state.status).toBe("success");
    expect(state.turns).toBe(1);
    expect(events.some((e) => e.type === "text" && e.text === "hello")).toBe(true);
  });

  test("runs a tool then finishes", async () => {
    await Bun.write(join(dir, "note.txt"), "x");
    const provider = new MockProvider([
      toolUseResponse("glob", { pattern: "*.txt" }),
      textResponse("done"),
    ]);
    const { events, state } = await collect(runQuery("list txt", config(provider)));
    expect(state.status).toBe("success");
    expect(state.turns).toBe(2);
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult && toolResult.type === "tool_result" && toolResult.output).toContain(
      "note.txt",
    );
    expect(events.some((e) => e.type === "text" && e.text === "done")).toBe(true);
  });

  test("stops at max turns with a typed status", async () => {
    const provider = new MockProvider([() => toolUseResponse("glob", { pattern: "*" })]);
    const { state } = await collect(runQuery("loop", config(provider, { maxTurns: 2 })));
    expect(state.status).toBe("max_turns");
    expect(state.turns).toBe(2);
  });

  test("blocks a mutating tool in default mode with no approver", async () => {
    const provider = new MockProvider([
      toolUseResponse("file_write", { path: "x.txt", content: "hi" }),
      textResponse("ok"),
    ]);
    const { events, state } = await collect(
      runQuery("write", config(provider, { mode: "default" })),
    );
    const result = events.find((e) => e.type === "tool_result");
    expect(result && result.type === "tool_result" && result.isError).toBe(true);
    expect(result && result.type === "tool_result" && result.output).toContain("Approval required");
    expect(await Bun.file(join(dir, "x.txt")).exists()).toBe(false);
    expect(state.status).toBe("success");
  });

  test("acceptEdits lets a write through", async () => {
    const provider = new MockProvider([
      toolUseResponse("file_write", { path: "y.txt", content: "hi" }),
      textResponse("ok"),
    ]);
    await collect(runQuery("write", config(provider, { mode: "acceptEdits" })));
    expect(await Bun.file(join(dir, "y.txt")).text()).toBe("hi");
  });

  test("retries a transient provider error then succeeds", async () => {
    const provider = new MockProvider([
      new ProviderError("overloaded", { retryable: true, retryAfterMs: 1 }),
      textResponse("recovered"),
    ]);
    const { events, state } = await collect(runQuery("hi", config(provider)));
    expect(events.some((e) => e.type === "retrying")).toBe(true);
    expect(events.some((e) => e.type === "text" && e.text === "recovered")).toBe(true);
    expect(state.status).toBe("success");
  });

  test("a non-retryable provider error ends with provider_error", async () => {
    const provider = new MockProvider([new ProviderError("bad request", { retryable: false })]);
    const { state } = await collect(runQuery("hi", config(provider)));
    expect(state.status).toBe("provider_error");
  });
});
