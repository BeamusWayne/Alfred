/**
 * Unit tests for OpenAIProvider (ADR 0005).
 *
 * All tests inject a fake fetcher — no real network traffic.
 */
import { describe, expect, test } from "bun:test";
import { OpenAIProvider, type Fetcher } from "../src/providers/openai.ts";
import { ProviderError } from "../src/providers/types.ts";
import type { Message, ToolDefinition, ProviderConfig } from "../src/providers/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetcher(status: number, body: unknown, headers: Record<string, string> = {}): {
  fetcher: Fetcher;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
  };
  return { fetcher, calls };
}

const BASE_CONFIG: ProviderConfig = {
  model: "gpt-4o",
  apiKey: "sk-test-key",
  maxTokens: 1024,
};

const USER_MESSAGES: readonly Message[] = [
  { role: "user", content: "Hello, world!" },
];

// ---------------------------------------------------------------------------
// 1. Text completion (finish_reason = "stop")
// ---------------------------------------------------------------------------

describe("OpenAIProvider — text completion", () => {
  test("maps stop → end_turn, text block, and usage correctly", async () => {
    const responseBody = {
      id: "chatcmpl-abc",
      model: "gpt-4o",
      choices: [
        {
          message: { role: "assistant", content: "Hi there!", tool_calls: undefined },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    };

    const { fetcher } = makeFetcher(200, responseBody);
    const provider = new OpenAIProvider(fetcher);

    const result = await provider.chat(USER_MESSAGES, [], BASE_CONFIG);

    expect(result.stopReason).toBe("end_turn");
    expect(result.model).toBe("gpt-4o");
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: "text", text: "Hi there!" });

    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Tool call completion (finish_reason = "tool_calls")
// ---------------------------------------------------------------------------

describe("OpenAIProvider — tool call completion", () => {
  test("maps tool_calls → tool_use block with parsed input and stopReason tool_use", async () => {
    const responseBody = {
      id: "chatcmpl-def",
      model: "gpt-4o",
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: "/etc/hosts" }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 8 },
    };

    const { fetcher } = makeFetcher(200, responseBody);
    const provider = new OpenAIProvider(fetcher);

    const tools: readonly ToolDefinition[] = [
      {
        name: "read_file",
        description: "Read a file from disk",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
    ];

    const result = await provider.chat(USER_MESSAGES, tools, BASE_CONFIG);

    expect(result.stopReason).toBe("tool_use");
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({
      type: "tool_use",
      id: "call_1",
      name: "read_file",
      input: { path: "/etc/hosts" },
    });
  });
});

// ---------------------------------------------------------------------------
// 3. 429 → ProviderError with retryable: true
// ---------------------------------------------------------------------------

describe("OpenAIProvider — rate limit error", () => {
  test("429 throws ProviderError with retryable=true and retryAfterMs", async () => {
    const { fetcher } = makeFetcher(
      429,
      { error: { message: "Rate limit exceeded" } },
      { "retry-after": "2" },
    );
    const provider = new OpenAIProvider(fetcher);

    let caught: unknown;
    try {
      await provider.chat(USER_MESSAGES, [], BASE_CONFIG);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ProviderError);
    const pe = caught as ProviderError;
    expect(pe.retryable).toBe(true);
    expect(pe.status).toBe(429);
    expect(pe.retryAfterMs).toBe(2000);
    expect(pe.message).toBe("Rate limit exceeded");
  });
});

// ---------------------------------------------------------------------------
// 4. Request shape — verify mapped messages and tools reach the fetcher
// ---------------------------------------------------------------------------

describe("OpenAIProvider — request shape", () => {
  test("sends system prompt, mapped messages, and tools in POST body", async () => {
    const responseBody = {
      id: "chatcmpl-xyz",
      model: "gpt-4o",
      choices: [
        {
          message: { role: "assistant", content: "OK", tool_calls: undefined },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 15, completion_tokens: 2 },
    };

    const { fetcher, calls } = makeFetcher(200, responseBody);
    const provider = new OpenAIProvider(fetcher, "https://api.openai.com/v1");

    const config: ProviderConfig = {
      ...BASE_CONFIG,
      systemPrompt: "You are a helpful assistant.",
    };

    const tools: readonly ToolDefinition[] = [
      {
        name: "list_files",
        description: "List files in a directory",
        inputSchema: { type: "object", properties: { dir: { type: "string" } } },
      },
    ];

    const messages: readonly Message[] = [
      { role: "user", content: "List /tmp" },
    ];

    await provider.chat(messages, tools, config);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;

    // URL
    expect(call.url).toBe("https://api.openai.com/v1/chat/completions");

    // Authorization header
    const init = call.init as { headers: Record<string, string>; body: string };
    expect(init.headers["Authorization"]).toBe("Bearer sk-test-key");

    const body = JSON.parse(init.body) as {
      model: string;
      messages: Array<{ role: string; content?: unknown }>;
      tools: Array<{ type: string; function: { name: string } }>;
    };

    // model forwarded
    expect(body.model).toBe("gpt-4o");

    // system prompt is the first message
    expect(body.messages[0]).toEqual({
      role: "system",
      content: "You are a helpful assistant.",
    });

    // user message next
    expect(body.messages[1]).toEqual({ role: "user", content: "List /tmp" });

    // tool mapped correctly
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]!.type).toBe("function");
    expect(body.tools[0]!.function.name).toBe("list_files");
  });

  test("maps tool_result messages to OpenAI tool role", async () => {
    const responseBody = {
      id: "chatcmpl-tool-result",
      model: "gpt-4o",
      choices: [
        {
          message: { role: "assistant", content: "Done.", tool_calls: undefined },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 30, completion_tokens: 3 },
    };

    const { fetcher, calls } = makeFetcher(200, responseBody);
    const provider = new OpenAIProvider(fetcher);

    const messages: readonly Message[] = [
      { role: "user", content: "Run the tool" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_99", name: "exec", input: { cmd: "ls" } },
        ],
      },
      {
        role: "tool_result",
        toolUseId: "call_99",
        content: "file1.txt\nfile2.txt",
        isError: false,
      },
    ];

    await provider.chat(messages, [], BASE_CONFIG);

    const body = JSON.parse(
      (calls[0]!.init as { body: string }).body,
    ) as { messages: Array<{ role: string; tool_call_id?: string; content?: string | null }> };

    const toolMsg = body.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.tool_call_id).toBe("call_99");
    expect(toolMsg?.content).toBe("file1.txt\nfile2.txt");
  });
});

// ---------------------------------------------------------------------------
// 5. Graceful handling of malformed tool call arguments
// ---------------------------------------------------------------------------

describe("OpenAIProvider — malformed tool arguments", () => {
  test("returns empty object input when arguments JSON is invalid", async () => {
    const responseBody = {
      id: "chatcmpl-bad-args",
      model: "gpt-4o",
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_broken",
                type: "function",
                function: { name: "bad_tool", arguments: "NOT_VALID_JSON{{{{" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    };

    const { fetcher } = makeFetcher(200, responseBody);
    const provider = new OpenAIProvider(fetcher);

    const result = await provider.chat(USER_MESSAGES, [], BASE_CONFIG);

    expect(result.content).toHaveLength(1);
    const block = result.content[0]!;
    expect(block.type).toBe("tool_use");
    if (block.type === "tool_use") {
      expect(block.input).toEqual({});
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Missing API key
// ---------------------------------------------------------------------------

describe("OpenAIProvider — missing API key", () => {
  test("throws non-retryable ProviderError when apiKey absent and env unset", async () => {
    const { fetcher } = makeFetcher(200, {});
    const provider = new OpenAIProvider(fetcher);

    const configNoKey: ProviderConfig = { model: "gpt-4o" };

    // Ensure the env var is absent for this test
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    let caught: unknown;
    try {
      await provider.chat(USER_MESSAGES, [], configNoKey);
    } catch (err) {
      caught = err;
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }

    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Malformed-response + network resilience
// ---------------------------------------------------------------------------

describe("OpenAIProvider — malformed response + network resilience", () => {
  test("usage:{} yields finite zero tokens (no NaN that would defeat the budget guard)", async () => {
    const { fetcher } = makeFetcher(200, {
      id: "x",
      model: "glm-4.6",
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: {},
    });
    const result = await new OpenAIProvider(fetcher).chat(USER_MESSAGES, [], BASE_CONFIG);
    expect(result.usage.inputTokens).toBe(0);
    expect(result.usage.outputTokens).toBe(0);
    expect(Number.isNaN(result.usage.inputTokens)).toBe(false);
  });

  test("a choice without a message throws a clean ProviderError, not a TypeError", async () => {
    const { fetcher } = makeFetcher(200, {
      id: "x",
      model: "glm-4.6",
      choices: [{ finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    let caught: unknown;
    try {
      await new OpenAIProvider(fetcher).chat(USER_MESSAGES, [], BASE_CONFIG);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderError);
  });

  test("a thrown network error maps to a RETRYABLE ProviderError", async () => {
    const fetcher: Fetcher = async () => {
      throw new TypeError("fetch failed");
    };
    let caught: unknown;
    try {
      await new OpenAIProvider(fetcher).chat(USER_MESSAGES, [], BASE_CONFIG);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).retryable).toBe(true);
  });

  test("a user abort is NOT wrapped as retryable", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher: Fetcher = async () => {
      const e = new Error("The operation was aborted");
      e.name = "AbortError";
      throw e;
    };
    let caught: unknown;
    try {
      await new OpenAIProvider(fetcher).chat(USER_MESSAGES, [], BASE_CONFIG, { signal: controller.signal });
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeInstanceOf(ProviderError); // the AbortError propagates unchanged
  });

  test("504 Gateway Timeout is retryable", async () => {
    const { fetcher } = makeFetcher(504, { error: { message: "gateway timeout" } });
    let caught: unknown;
    try {
      await new OpenAIProvider(fetcher).chat(USER_MESSAGES, [], BASE_CONFIG);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).retryable).toBe(true);
  });
});
