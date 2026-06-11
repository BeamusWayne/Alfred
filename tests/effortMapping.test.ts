/**
 * Effort + native structured-output mapping on non-Anthropic providers.
 * Contract: the catalog decides; each provider translates to its own knob and
 * never sends a parameter the model would reject.
 */
import { describe, test, expect } from "bun:test";
import { requestBody } from "../src/providers/openai.ts";
import { GoogleProvider } from "../src/providers/google.ts";
import { buildRequest } from "../src/providers/anthropic.ts";
import { toStrictJsonSchema } from "../src/orchestrator/strictSchema.ts";
import type { Message } from "../src/providers/types.ts";

const MSGS: readonly Message[] = [{ role: "user", content: "hi" }];

describe("OpenAI requestBody — reasoning models", () => {
  test("gpt-5 gets reasoning_effort + max_completion_tokens, never temperature/max_tokens", () => {
    const body = requestBody(MSGS, [], { model: "gpt-5", effort: "xhigh", temperature: 0.7 });
    expect(body.reasoning_effort).toBe("high"); // xhigh tops out at OpenAI's "high"
    expect(body.max_completion_tokens).toBeDefined();
    expect("max_tokens" in body).toBe(false);
    expect("temperature" in body).toBe(false);
  });

  test("o3 maps low/medium/high directly", () => {
    expect(requestBody(MSGS, [], { model: "o3", effort: "medium" }).reasoning_effort).toBe(
      "medium",
    );
  });

  test("gpt-4o keeps classic params and never gets reasoning_effort", () => {
    const body = requestBody(MSGS, [], { model: "gpt-4o", effort: "high", temperature: 0.3 });
    expect("reasoning_effort" in body).toBe(false);
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBeDefined();
    expect("max_completion_tokens" in body).toBe(false);
  });

  test("response_format rides only on structured-output models", () => {
    const schema = { type: "object", properties: {}, additionalProperties: false };
    const withIt = requestBody(MSGS, [], { model: "gpt-4o", responseSchema: schema });
    expect(withIt.response_format?.json_schema.schema).toEqual(schema);
    const without = requestBody(MSGS, [], { model: "unknown-model", responseSchema: schema });
    expect("response_format" in without).toBe(false);
  });
});

describe("Gemini generationConfig — thinkingBudget", () => {
  async function bodyFor(model: string, effort?: "low" | "medium" | "high" | "xhigh" | "max") {
    let captured: Record<string, unknown> = {};
    const fetcher = async (_url: string, init: RequestInit) => {
      captured = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
        { status: 200 },
      );
    };
    await new GoogleProvider(fetcher).chat(MSGS, [], { model, apiKey: "test-key", effort });
    return captured;
  }

  test("gemini-2.5-pro maps effort to a thinking budget", async () => {
    const body = await bodyFor("gemini-2.5-pro", "low");
    const gen = body.generationConfig as Record<string, unknown>;
    expect(gen.thinkingConfig).toEqual({ thinkingBudget: 1_024 });
  });

  test("xhigh/max hit the 2.5 ceiling", async () => {
    const body = await bodyFor("gemini-2.5-pro", "max");
    const gen = body.generationConfig as Record<string, unknown>;
    expect(gen.thinkingConfig).toEqual({ thinkingBudget: 32_768 });
  });

  test("gemini-2.0-flash never gets a thinkingConfig", async () => {
    const body = await bodyFor("gemini-2.0-flash", "high");
    const gen = body.generationConfig as Record<string, unknown>;
    expect("thinkingConfig" in gen).toBe(false);
  });

  test("no effort → no thinkingConfig (dynamic default preserved)", async () => {
    const body = await bodyFor("gemini-2.5-flash");
    const gen = body.generationConfig as Record<string, unknown>;
    expect("thinkingConfig" in gen).toBe(false);
  });
});

describe("Anthropic output_config.format", () => {
  test("responseSchema becomes output_config.format on supporting models", () => {
    const schema = { type: "object", properties: {}, additionalProperties: false };
    const { params } = buildRequest(
      MSGS,
      [],
      { model: "claude-fable-5", responseSchema: schema },
      false,
    );
    expect(params.output_config?.format).toEqual({ type: "json_schema", schema });
  });

  test("GLM via the compatible endpoint never gets output_config", () => {
    const schema = { type: "object", properties: {}, additionalProperties: false };
    const { params } = buildRequest(MSGS, [], { model: "glm-4.6", responseSchema: schema }, false);
    expect("output_config" in params).toBe(false);
  });
});

describe("toStrictJsonSchema", () => {
  test("adds additionalProperties:false recursively and strips $schema", () => {
    const out = toStrictJsonSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        steps: {
          type: "array",
          items: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        },
      },
      required: ["steps"],
    });
    expect(out).not.toBeNull();
    expect(out?.$schema).toBeUndefined();
    expect(out?.additionalProperties).toBe(false);
    const steps = (out?.properties as Record<string, Record<string, unknown>> | undefined)?.steps;
    expect((steps?.items as Record<string, unknown> | undefined)?.additionalProperties).toBe(false);
  });

  test("returns null when a property is optional (strict-unsafe)", () => {
    const out = toStrictJsonSchema({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a"],
    });
    expect(out).toBeNull();
  });

  test("never mutates the input schema", () => {
    const input = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
    const before = JSON.stringify(input);
    toStrictJsonSchema(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
