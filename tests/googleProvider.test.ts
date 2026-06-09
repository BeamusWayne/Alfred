/**
 * Unit tests for GoogleProvider (native Gemini generateContent), ADR 0005.
 * All offline via an injected fetcher — no real network.
 */
import { describe, expect, test } from "bun:test";
import { GoogleProvider, type Fetcher } from "../src/providers/google.ts";
import { ProviderError } from "../src/providers/types.ts";
import type { Message, ToolDefinition, ProviderConfig } from "../src/providers/types.ts";

function makeFetcher(status: number, body: unknown): {
  fetcher: Fetcher;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetcher, calls };
}

const CONFIG: ProviderConfig = { model: "gemini-2.5-flash", apiKey: "AIza-test", maxTokens: 1024 };
const USER: readonly Message[] = [{ role: "user", content: "hi" }];

function geminiText(text: string, finishReason = "STOP"): unknown {
  return {
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    modelVersion: "gemini-2.5-flash",
  };
}

describe("GoogleProvider — text completion", () => {
  test("maps a text candidate to end_turn + a text block + usage", async () => {
    const { fetcher } = makeFetcher(200, geminiText("hello there"));
    const r = await new GoogleProvider(fetcher).chat(USER, [], CONFIG);
    expect(r.stopReason).toBe("end_turn");
    expect(r.content).toEqual([{ type: "text", text: "hello there" }]);
    expect(r.usage.inputTokens).toBe(10);
    expect(r.usage.outputTokens).toBe(5);
  });

  test("request hits :generateContent with the api-key header and Gemini body shape", async () => {
    const { fetcher, calls } = makeFetcher(200, geminiText("ok"));
    await new GoogleProvider(fetcher).chat(USER, [], { ...CONFIG, systemPrompt: "be terse" });
    const call = calls[0]!;
    expect(call.url).toContain("/models/gemini-2.5-flash:generateContent");
    expect((call.init.headers as Record<string, string>)["x-goog-api-key"]).toBe("AIza-test");
    const body = JSON.parse(call.init.body as string);
    expect(body.systemInstruction.parts[0].text).toBe("be terse");
    expect(body.contents[0]).toEqual({ role: "user", parts: [{ text: "hi" }] });
    expect(body.generationConfig.maxOutputTokens).toBe(1024);
  });
});

describe("GoogleProvider — tool calling", () => {
  test("a functionCall part becomes a tool_use block with stopReason tool_use", async () => {
    const { fetcher } = makeFetcher(200, {
      // Gemini reports finishReason STOP even for tool calls.
      candidates: [
        {
          content: { role: "model", parts: [{ functionCall: { name: "bash", args: { command: "ls" } } }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
    });
    const r = await new GoogleProvider(fetcher).chat(USER, [], CONFIG);
    expect(r.stopReason).toBe("tool_use");
    expect(r.content).toHaveLength(1);
    const block = r.content[0]!;
    expect(block.type).toBe("tool_use");
    if (block.type === "tool_use") {
      expect(block.name).toBe("bash");
      expect(block.input).toEqual({ command: "ls" });
    }
  });

  test("tool definitions are sent as sanitized functionDeclarations", async () => {
    const { fetcher, calls } = makeFetcher(200, geminiText("ok"));
    const tools: ToolDefinition[] = [
      {
        name: "bash",
        description: "run a command",
        inputSchema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          additionalProperties: false,
          properties: { command: { type: "string", additionalProperties: false } },
          required: ["command"],
        },
      },
    ];
    await new GoogleProvider(fetcher).chat(USER, tools, CONFIG);
    const body = JSON.parse(calls[0]!.init.body as string);
    const decl = body.tools[0].functionDeclarations[0];
    expect(decl.name).toBe("bash");
    // Gemini-incompatible JSON-Schema keys are stripped at every level.
    expect(JSON.stringify(decl)).not.toContain("$schema");
    expect(JSON.stringify(decl)).not.toContain("additionalProperties");
    expect(decl.parameters.properties.command.type).toBe("string");
  });

  test("strips numeric/string constraints Gemini rejects (exclusiveMinimum, format, …)", async () => {
    const { fetcher, calls } = makeFetcher(200, geminiText("ok"));
    const tools: ToolDefinition[] = [
      {
        name: "paginate",
        description: "page",
        inputSchema: {
          type: "object",
          properties: {
            // Zod's .int().positive() / .url() emit exactly these.
            page: { type: "integer", exclusiveMinimum: 0, minimum: 1, multipleOf: 1 },
            url: { type: "string", format: "uri", minLength: 1, pattern: "^https?://" },
            tags: { type: "array", items: { type: "string", maxLength: 20 } },
          },
          required: ["page"],
        },
      },
    ];
    await new GoogleProvider(fetcher).chat(USER, tools, CONFIG);
    const decl = JSON.parse(calls[0]!.init.body as string).tools[0].functionDeclarations[0];
    const flat = JSON.stringify(decl);
    for (const banned of ["exclusiveMinimum", "minimum", "multipleOf", "format", "minLength", "pattern", "maxLength"]) {
      expect(flat).not.toContain(banned);
    }
    // Structural keywords survive.
    expect(decl.parameters.properties.page.type).toBe("integer");
    expect(decl.parameters.properties.url.type).toBe("string");
    expect(decl.parameters.properties.tags.items.type).toBe("string");
    expect(decl.parameters.required).toEqual(["page"]);
  });

  test("a tool_result is replayed as a functionResponse keyed by the call's name", async () => {
    const { fetcher, calls } = makeFetcher(200, geminiText("done"));
    const convo: Message[] = [
      { role: "user", content: "list files" },
      { role: "assistant", content: [{ type: "tool_use", id: "call_bash_0", name: "bash", input: { command: "ls" } }] },
      { role: "tool_result", toolUseId: "call_bash_0", content: "a.txt\nb.txt", isError: false },
    ];
    await new GoogleProvider(fetcher).chat(convo, [], CONFIG);
    const body = JSON.parse(calls[0]!.init.body as string);
    // Last content is the tool result, as a functionResponse named "bash".
    const last = body.contents[body.contents.length - 1];
    expect(last.role).toBe("user");
    expect(last.parts[0].functionResponse.name).toBe("bash"); // looked up from the call id
    expect(last.parts[0].functionResponse.response).toEqual({ result: "a.txt\nb.txt" });
  });
});

describe("GoogleProvider — resilience", () => {
  test("usageMetadata absent yields finite zero tokens (no NaN)", async () => {
    const { fetcher } = makeFetcher(200, {
      candidates: [{ content: { role: "model", parts: [{ text: "x" }] }, finishReason: "STOP" }],
    });
    const r = await new GoogleProvider(fetcher).chat(USER, [], CONFIG);
    expect(r.usage.inputTokens).toBe(0);
    expect(Number.isNaN(r.usage.outputTokens)).toBe(false);
  });

  test("no candidates (safety block) throws a clear ProviderError", async () => {
    const { fetcher } = makeFetcher(200, { promptFeedback: { blockReason: "SAFETY" } });
    let caught: unknown;
    try {
      await new GoogleProvider(fetcher).chat(USER, [], CONFIG);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).message).toContain("SAFETY");
  });

  test("429 is retryable; 400 is not", async () => {
    const rl = makeFetcher(429, { error: { message: "rate limited" } });
    const bad = makeFetcher(400, { error: { message: "bad model" } });
    const p429 = new GoogleProvider(rl.fetcher).chat(USER, [], CONFIG).catch((e) => e);
    const p400 = new GoogleProvider(bad.fetcher).chat(USER, [], CONFIG).catch((e) => e);
    expect(((await p429) as ProviderError).retryable).toBe(true);
    expect(((await p400) as ProviderError).retryable).toBe(false);
  });

  test("a thrown network error maps to a retryable ProviderError", async () => {
    const fetcher: Fetcher = async () => {
      throw new TypeError("fetch failed");
    };
    const e = await new GoogleProvider(fetcher).chat(USER, [], CONFIG).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as ProviderError).retryable).toBe(true);
  });

  test("missing api key throws a non-retryable ProviderError", async () => {
    const { fetcher } = makeFetcher(200, geminiText("x"));
    const e = await new GoogleProvider(fetcher)
      .chat(USER, [], { model: "gemini-2.5-flash" })
      .catch((x) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as ProviderError).retryable).toBe(false);
  });
});
