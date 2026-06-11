/**
 * Tests for QueryConfig.initialMessages (REPL multi-turn): the engine seeds
 * the conversation with the prior turn's messages, the provider sees the
 * full history, and the caller can thread state.messages turn to turn.
 */
import { describe, expect, test } from "bun:test";
import { MockProvider, textResponse } from "../src/providers/mock.ts";
import { runQuery } from "../src/query/engine.ts";
import type { QueryState } from "../src/query/types.ts";

const PERMISSIONS = {
  mode: "bypass" as const,
  allowedTools: new Set<string>(),
  deniedTools: new Set<string>(),
  workingDir: "/tmp",
};

async function drain(gen: ReturnType<typeof runQuery>): Promise<QueryState> {
  let result = await gen.next();
  while (!result.done) result = await gen.next();
  return result.value;
}

describe("initialMessages", () => {
  test("second turn carries the first turn's history to the provider", async () => {
    // The scripted model reports how many messages it was shown.
    const provider = new MockProvider([(messages) => textResponse(`seen:${messages.length}`)]);

    const turn1 = await drain(
      runQuery("hello", { provider, model: "mock", permissions: PERMISSIONS }),
    );
    expect(turn1.status).toBe("success");
    expect(turn1.messages.length).toBe(2); // user + assistant
    expect(JSON.stringify(turn1.messages)).toContain("seen:1");

    const turn2 = await drain(
      runQuery("again", {
        provider,
        model: "mock",
        permissions: PERMISSIONS,
        initialMessages: turn1.messages,
      }),
    );
    expect(turn2.messages.length).toBe(4); // history + user + assistant
    expect(JSON.stringify(turn2.messages)).toContain("seen:3");
  });

  test("absent initialMessages keeps the old single-turn behavior", async () => {
    const provider = new MockProvider([(messages) => textResponse(`seen:${messages.length}`)]);
    const state = await drain(
      runQuery("solo", { provider, model: "mock", permissions: PERMISSIONS }),
    );
    expect(JSON.stringify(state.messages)).toContain("seen:1");
  });
});
