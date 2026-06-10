/**
 * Abnormal stop-reason handling in the agent loop (Fable-5-era correctness):
 *   - `max_tokens` truncation must NOT be reported as success — the loop asks
 *     the model to continue, bounded, then ends with status "truncated";
 *   - `model_context_window_exceeded` forces a compaction pass and retries;
 *   - `pause_turn` re-sends the transcript so the model resumes;
 *   - tool calls are dispatched on block presence, not stop reason (some
 *     OpenAI-compatible gateways return finish_reason "stop" with tool calls).
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runQuery } from "../src/query/engine.ts";
import type { QueryConfig, QueryEvent, QueryState } from "../src/query/types.ts";
import { MockProvider, textResponse } from "../src/providers/mock.ts";
import { ZERO_USAGE, type LLMResponse, type Provider } from "../src/providers/types.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "alfred-stop-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function config(provider: Provider, over: Partial<QueryConfig> = {}): QueryConfig {
  return {
    provider,
    model: "mock",
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

describe("max_tokens truncation", () => {
  test("asks the model to continue and succeeds when the continuation completes", async () => {
    const provider = new MockProvider([
      textResponse("first half…", "max_tokens"),
      textResponse("…second half.", "end_turn"),
    ]);
    const { state } = await collect(runQuery("long task", config(provider)));
    expect(state.status).toBe("success");
    // The continuation request carries the explicit continue instruction.
    const second = provider.calls[1];
    expect(second).toBeDefined();
    const last = second?.[second.length - 1];
    expect(last?.role).toBe("user");
    expect(String(last?.content)).toContain("cut off by the output token limit");
  });

  test("ends with status truncated after repeated truncations", async () => {
    const provider = new MockProvider([textResponse("partial", "max_tokens")]);
    const { events, state } = await collect(runQuery("long task", config(provider)));
    expect(state.status).toBe("truncated");
    expect(events.some((e) => e.type === "error" && e.message.includes("max_tokens"))).toBe(true);
    // 1 initial + 3 continuations = 4 calls, then give up.
    expect(provider.calls.length).toBe(4);
  });
});

describe("model_context_window_exceeded", () => {
  test("fails loudly when compaction cannot reclaim space", async () => {
    // Transcript too short to compact → forced compact is a no-op → second
    // overflow must end as provider_error, never silent success.
    const provider = new MockProvider([
      textResponse("x", "model_context_window_exceeded"),
      textResponse("y", "model_context_window_exceeded"),
    ]);
    const { events, state } = await collect(runQuery("hi", config(provider)));
    expect(state.status).toBe("provider_error");
    expect(events.some((e) => e.type === "error" && e.message.includes("Context window"))).toBe(
      true,
    );
  });
});

describe("pause_turn", () => {
  test("re-sends the transcript and completes on resume", async () => {
    const provider = new MockProvider([
      textResponse("working…", "pause_turn"),
      textResponse("done.", "end_turn"),
    ]);
    const { state } = await collect(runQuery("go", config(provider)));
    expect(state.status).toBe("success");
    expect(provider.calls.length).toBe(2);
  });

  test("gives up after repeated pauses", async () => {
    const provider = new MockProvider([textResponse("…", "pause_turn")]);
    const { state } = await collect(runQuery("go", config(provider, { maxTurns: 20 })));
    expect(state.status).toBe("provider_error");
    expect(provider.calls.length).toBe(6); // initial + 5 bounded resumes
  });
});

describe("tool dispatch on block presence", () => {
  test("executes tool calls even when stopReason is end_turn (gateway quirk)", async () => {
    await Bun.write(join(dir, "note.txt"), "hello");
    const quirky: LLMResponse = {
      content: [
        {
          type: "tool_use",
          id: "call_1",
          name: "file_read",
          input: { path: join(dir, "note.txt") },
        },
      ],
      stopReason: "end_turn",
      usage: ZERO_USAGE,
      model: "mock",
    };
    const provider = new MockProvider([quirky, textResponse("read it", "end_turn")]);
    const { events, state } = await collect(runQuery("read note", config(provider)));
    expect(state.status).toBe("success");
    expect(events.some((e) => e.type === "tool_result" && !e.isError)).toBe(true);
  });
});

describe("empty assistant content", () => {
  test("an empty truncated turn is not appended as an assistant message", async () => {
    const empty: LLMResponse = {
      content: [],
      stopReason: "max_tokens",
      usage: ZERO_USAGE,
      model: "mock",
    };
    const provider = new MockProvider([empty, textResponse("recovered", "end_turn")]);
    const { state } = await collect(runQuery("go", config(provider)));
    expect(state.status).toBe("success");
    const second = provider.calls[1] ?? [];
    expect(second.every((m) => m.role !== "assistant" || m.content.length > 0)).toBe(true);
  });
});
