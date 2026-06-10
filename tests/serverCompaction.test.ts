/**
 * Server-side compaction (beta compact-2026-01-12).
 *
 * Contract: supporting Anthropic models get `context_management` + the beta
 * header and their compaction blocks round-trip verbatim; while active, the
 * engine's LOCAL context editing/compaction stands down (the two must not
 * both rewrite history). Non-supporting models are untouched.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { buildRequest, fromContent, toAnthropicMessages } from "../src/providers/anthropic.ts";
import { runQuery } from "../src/query/engine.ts";
import { textResponse, toolUseResponse } from "../src/providers/mock.ts";
import {
  ZERO_USAGE,
  type LLMResponse,
  type Message,
  type Provider,
  type ProviderConfig,
  type ToolDefinition,
} from "../src/providers/types.ts";
import type { QueryState, QueryEvent } from "../src/query/types.ts";

const MSGS: readonly Message[] = [{ role: "user", content: "hi" }];

describe("buildRequest — context_management", () => {
  test("supporting model gets the edit + beta header", () => {
    const { params, betas } = buildRequest(
      MSGS,
      [],
      { model: "claude-fable-5", serverCompaction: { triggerTokens: 800_000 } },
      false,
    );
    expect((params as unknown as Record<string, unknown>).context_management).toEqual({
      edits: [
        { type: "compact_20260112", trigger: { type: "input_tokens", value: 800_000 } },
      ],
    });
    expect(betas).toEqual(["compact-2026-01-12"]);
  });

  test("beta headers merge when task_budget is also active", () => {
    const { betas } = buildRequest(
      MSGS,
      [],
      {
        model: "claude-fable-5",
        serverCompaction: { triggerTokens: 800_000 },
        taskBudgetTokens: 100_000,
      },
      false,
    );
    expect(betas).toEqual(["task-budgets-2026-03-13", "compact-2026-01-12"]);
  });

  test("non-supporting models never get the field (haiku, glm)", () => {
    for (const model of ["claude-haiku-4-5", "glm-4.6"]) {
      const { params, betas } = buildRequest(
        MSGS,
        [],
        { model, serverCompaction: { triggerTokens: 100_000 } },
        false,
      );
      expect("context_management" in params).toBe(false);
      expect(betas).toEqual([]);
    }
  });
});

describe("compaction block round-trip", () => {
  test("response → ContentBlock → request param, verbatim", () => {
    const blocks = fromContent([
      { type: "compaction", content: "summary…", encrypted_content: "opaque" } as never,
      { type: "text", text: "go on", citations: null },
    ]);
    expect(blocks[0]).toEqual({ type: "compaction", content: "summary…", encryptedContent: "opaque" });
    const params = toAnthropicMessages([
      { role: "user", content: "q" },
      { role: "assistant", content: blocks },
    ]);
    expect(params[1]?.content as unknown).toEqual([
      { type: "compaction", content: "summary…", encrypted_content: "opaque" },
      { type: "text", text: "go on" },
    ]);
  });

  test("failed compaction (null content) round-trips as a no-op block", () => {
    const blocks = fromContent([
      { type: "compaction", content: null, encrypted_content: null } as never,
    ]);
    expect(blocks[0]).toEqual({ type: "compaction", content: null, encryptedContent: null });
  });
});

/** A scriptable provider that *claims* to be anthropic, to exercise gating. */
class FakeAnthropic implements Provider {
  readonly name = "anthropic";
  readonly configs: ProviderConfig[] = [];
  readonly calls: Array<readonly Message[]> = [];
  private i = 0;
  constructor(private readonly scripts: readonly LLMResponse[]) {}
  async chat(
    messages: readonly Message[],
    _tools: readonly ToolDefinition[],
    config: ProviderConfig,
  ): Promise<LLMResponse> {
    this.calls.push([...messages]);
    this.configs.push(config);
    const s = this.scripts[Math.min(this.i++, this.scripts.length - 1)];
    return s ?? textResponse("(no script)");
  }
}

async function drain(gen: AsyncGenerator<QueryEvent, QueryState>): Promise<QueryState> {
  let r = await gen.next();
  while (!r.done) r = await gen.next();
  return r.value;
}

const PERMS = {
  mode: "bypass" as const,
  allowedTools: new Set<string>(),
  deniedTools: new Set<string>(),
  workingDir: "/tmp",
};

afterEach(() => {
  delete process.env.ALFRED_SERVER_COMPACT;
});

describe("engine gating", () => {
  test("anthropic provider + supporting model → serverCompaction at 80% of the window", async () => {
    const provider = new FakeAnthropic([textResponse("ok")]);
    await drain(runQuery("hi", { provider, model: "claude-fable-5", permissions: PERMS }));
    expect(provider.configs[0]?.serverCompaction).toEqual({ triggerTokens: 800_000 });
  });

  test("ALFRED_SERVER_COMPACT=0 opts out", async () => {
    process.env.ALFRED_SERVER_COMPACT = "0";
    const provider = new FakeAnthropic([textResponse("ok")]);
    await drain(runQuery("hi", { provider, model: "claude-fable-5", permissions: PERMS }));
    expect(provider.configs[0]?.serverCompaction).toBeUndefined();
  });

  test("non-anthropic provider never gets it", async () => {
    const provider = new FakeAnthropic([textResponse("ok")]);
    Object.defineProperty(provider, "name", { value: "openai" });
    await drain(runQuery("hi", { provider, model: "claude-fable-5", permissions: PERMS }));
    expect(provider.configs[0]?.serverCompaction).toBeUndefined();
  });

  test("local context editing stands down while server compaction is active", async () => {
    // Six fat tool turns push old tool_results past the protected window
    // (keepRecent=6); a tiny pinned context would normally trigger local
    // eviction ("[tool result evicted…]" placeholders).
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "alfred-sc-"));
    await writeFile(join(dir, "big.txt"), "x".repeat(2_000));
    const perms = { ...PERMS, workingDir: dir };
    const scripts: LLMResponse[] = [
      ...Array.from({ length: 6 }, (_, i) =>
        toolUseResponse("file_read", { path: join(dir, "big.txt") }, { id: `t${i}` }),
      ),
      textResponse("done"),
    ];

    // Server compaction ON: original tool_result bodies must survive locally.
    const onProvider = new FakeAnthropic(scripts);
    await drain(
      runQuery("go", {
        provider: onProvider,
        model: "claude-fable-5",
        permissions: perms,
        maxContextTokens: 200,
      }),
    );
    // History reached the provider untouched: no eviction placeholders, no
    // local "[Context summary" rewrite, full message count.
    const lastOn = onProvider.calls[onProvider.calls.length - 1] ?? [];
    expect(lastOn.some((m) => m.role === "tool_result" && m.content.includes("evicted"))).toBe(
      false,
    );
    expect(
      lastOn.some(
        (m) =>
          m.role === "user" &&
          typeof m.content === "string" &&
          m.content.includes("[Context summary"),
      ),
    ).toBe(false);
    expect(lastOn.length).toBe(13); // user + 6×(assistant+tool_result)

    // Server compaction OFF (env opt-out): local context management rewrites
    // history as before (eviction placeholder and/or compaction summary).
    process.env.ALFRED_SERVER_COMPACT = "0";
    const offProvider = new FakeAnthropic(scripts);
    await drain(
      runQuery("go", {
        provider: offProvider,
        model: "claude-fable-5",
        permissions: perms,
        maxContextTokens: 200,
      }),
    );
    const lastOff = offProvider.calls[offProvider.calls.length - 1] ?? [];
    const rewritten = lastOff.some(
      (m) =>
        (m.role === "tool_result" && m.content.includes("evicted")) ||
        (m.role === "user" &&
          typeof m.content === "string" &&
          m.content.includes("[Context summary")),
    );
    expect(rewritten).toBe(true);
  });
});
