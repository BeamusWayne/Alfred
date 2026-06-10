/**
 * ALFRED_BASE_URL is scoped to the anthropic provider (it means
 * "Anthropic-compatible endpoint", e.g. Zhipu GLM). A real-world .env that
 * pins it for GLM must never poison Gemini/OpenAI request URLs.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { loadConfig } from "../src/config/manager.ts";
import { GoogleProvider } from "../src/providers/google.ts";
import type { Message } from "../src/providers/types.ts";

const ZHIPU = "https://open.bigmodel.cn/api/anthropic";
const MSGS: readonly Message[] = [{ role: "user", content: "hi" }];

afterEach(() => {
  delete process.env.ALFRED_BASE_URL;
  delete process.env.GEMINI_BASE_URL;
});

describe("config-level scoping", () => {
  test("anthropic gets ALFRED_BASE_URL; google/openai do not", () => {
    process.env.ALFRED_BASE_URL = ZHIPU;
    expect(loadConfig({ provider: "anthropic" }).baseUrl).toBe(ZHIPU);
    expect(loadConfig({ provider: "google" }).baseUrl).toBeUndefined();
    expect(loadConfig({ provider: "openai" }).baseUrl).toBeUndefined();
  });

  test("an explicit override still wins for any provider", () => {
    expect(loadConfig({ provider: "google", baseUrl: "https://proxy.example" }).baseUrl).toBe(
      "https://proxy.example",
    );
  });
});

describe("GoogleProvider endpoint", () => {
  async function requestUrl(): Promise<string> {
    let url = "";
    const fetcher = async (u: string) => {
      url = u;
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
        { status: 200 },
      );
    };
    await new GoogleProvider(fetcher).chat(MSGS, [], {
      model: "gemini-2.5-flash",
      apiKey: "test-key",
    });
    return url;
  }

  test("ignores ALFRED_BASE_URL (stays on the Gemini API)", async () => {
    process.env.ALFRED_BASE_URL = ZHIPU;
    const url = await requestUrl();
    expect(url).toContain("generativelanguage.googleapis.com");
    expect(url).not.toContain("bigmodel.cn");
  });

  test("GEMINI_BASE_URL is the provider-scoped override", async () => {
    process.env.GEMINI_BASE_URL = "https://gemini-proxy.example";
    const url = await requestUrl();
    expect(url.startsWith("https://gemini-proxy.example/")).toBe(true);
  });
});
