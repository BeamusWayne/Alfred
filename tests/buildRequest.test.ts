/**
 * `buildRequest` — the capability-gated request builder for the Anthropic
 * provider. The contract under test: no configured model ever receives a
 * parameter it would 400 on, and capable models get their long-task features
 * (adaptive thinking, effort, task_budget) without per-call site plumbing.
 */
import { describe, expect, test } from "bun:test";
import { buildRequest, fromContent, toAnthropicMessages } from "../src/providers/anthropic.ts";
import type { Message, ProviderConfig } from "../src/providers/types.ts";

const MESSAGES: readonly Message[] = [{ role: "user", content: "hi" }];

function cfg(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return { model: "claude-fable-5", ...over };
}

describe("buildRequest — sampling param gating", () => {
  test("temperature is dropped on Fable 5 (would 400)", () => {
    const { params } = buildRequest(MESSAGES, [], cfg({ temperature: 0.7 }), false);
    expect("temperature" in params).toBe(false);
  });

  test("temperature passes through on Opus 4.6", () => {
    const { params } = buildRequest(
      MESSAGES,
      [],
      cfg({ model: "claude-opus-4-6", temperature: 0.5 }),
      false,
    );
    expect(params.temperature).toBe(0.5);
  });
});

describe("buildRequest — thinking", () => {
  test("adaptive thinking is on by default for Fable 5", () => {
    const { params } = buildRequest(MESSAGES, [], cfg(), false);
    expect(params.thinking).toEqual({ type: "adaptive" });
  });

  test('thinking: "none" omits the field entirely (Fable 5 rejects explicit disabled)', () => {
    const { params } = buildRequest(MESSAGES, [], cfg({ thinking: "none" }), false);
    expect("thinking" in params).toBe(false);
  });

  test("models without adaptive support never get a thinking field", () => {
    for (const model of ["glm-4.6", "claude-haiku-4-5", "unknown-model"]) {
      const { params } = buildRequest(MESSAGES, [], cfg({ model }), false);
      expect("thinking" in params).toBe(false);
    }
  });
});

describe("buildRequest — effort and task_budget", () => {
  test("effort rides output_config on supporting models", () => {
    const { params, betas } = buildRequest(MESSAGES, [], cfg({ effort: "xhigh" }), false);
    expect(params.output_config).toEqual({ effort: "xhigh" });
    expect(betas).toEqual([]);
  });

  test("effort is dropped on models without support", () => {
    const { params } = buildRequest(MESSAGES, [], cfg({ model: "glm-4.6", effort: "high" }), false);
    expect("output_config" in params).toBe(false);
  });

  test("task_budget is sent with its beta header when ≥ 20k on a supporting model", () => {
    const { params, betas } = buildRequest(MESSAGES, [], cfg({ taskBudgetTokens: 150_000 }), false);
    expect(params.output_config).toMatchObject({
      task_budget: { type: "tokens", total: 150_000 },
    });
    expect(betas).toEqual(["task-budgets-2026-03-13"]);
  });

  test("task_budget below the 20k API minimum is not sent", () => {
    const { params, betas } = buildRequest(MESSAGES, [], cfg({ taskBudgetTokens: 5_000 }), false);
    expect("output_config" in params).toBe(false);
    expect(betas).toEqual([]);
  });

  test("task_budget is dropped on non-supporting models (opus 4.6)", () => {
    const { params, betas } = buildRequest(
      MESSAGES,
      [],
      cfg({ model: "claude-opus-4-6", taskBudgetTokens: 100_000 }),
      false,
    );
    expect("output_config" in params).toBe(false);
    expect(betas).toEqual([]);
  });
});

describe("buildRequest — max_tokens", () => {
  test("defaults from the catalog: 64K streaming, 16K non-streaming on Fable 5", () => {
    expect(buildRequest(MESSAGES, [], cfg(), true).params.max_tokens).toBe(64_000);
    expect(buildRequest(MESSAGES, [], cfg(), false).params.max_tokens).toBe(16_000);
  });

  test("explicit maxTokens is honoured but capped at the model ceiling", () => {
    expect(buildRequest(MESSAGES, [], cfg({ maxTokens: 100_000 }), true).params.max_tokens).toBe(
      100_000,
    );
    // Fallback-chain switch to a small model: the cap follows the new model.
    expect(
      buildRequest(MESSAGES, [], cfg({ model: "glm-4.6", maxTokens: 100_000 }), true).params
        .max_tokens,
    ).toBe(8_192);
  });
});

describe("thinking block fidelity", () => {
  test("assistant thinking blocks round-trip into request params verbatim", () => {
    const messages: readonly Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan…", signature: "sig123" },
          { type: "redacted_thinking", data: "opaque" },
          { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
        ],
      },
    ];
    const params = toAnthropicMessages(messages);
    expect(params[1]?.content).toEqual([
      { type: "thinking", thinking: "plan…", signature: "sig123" },
      { type: "redacted_thinking", data: "opaque" },
      { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
    ]);
  });

  test("response thinking blocks are preserved by fromContent", () => {
    const content = fromContent([
      { type: "thinking", thinking: "reasoning", signature: "s" },
      { type: "text", text: "answer", citations: null },
    ]);
    expect(content).toEqual([
      { type: "thinking", thinking: "reasoning", signature: "s" },
      { type: "text", text: "answer" },
    ]);
  });
});
