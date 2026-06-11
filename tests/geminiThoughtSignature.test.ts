/**
 * Gemini 3.x thought signatures: the API returns `thoughtSignature` on
 * functionCall parts and REJECTS later requests whose echoed history lost
 * them ("Function call is missing a thought_signature…" — found live with
 * gemini-3.1-pro-preview). Contract: capture on parse, echo verbatim on
 * serialise, and never surface `thought: true` reasoning parts as text.
 */
import { describe, test, expect } from "bun:test";
import { GoogleProvider } from "../src/providers/google.ts";
import type { Message } from "../src/providers/types.ts";

function geminiReply(parts: unknown[]): Response {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts }, finishReason: "STOP" }] }),
    { status: 200 },
  );
}

describe("Gemini thought signatures", () => {
  test("captures thoughtSignature from functionCall parts into providerMeta", async () => {
    const fetcher = async () =>
      geminiReply([
        { thought: true, text: "internal reasoning summary", thoughtSignature: "tsig-think" },
        { functionCall: { name: "glob", args: { pattern: "*" } }, thoughtSignature: "tsig-1" },
      ]);
    const r = await new GoogleProvider(fetcher).chat([{ role: "user", content: "go" }], [], {
      model: "gemini-3.1-pro-preview",
      apiKey: "k",
    });
    expect(r.stopReason).toBe("tool_use");
    expect(r.content).toEqual([
      {
        type: "tool_use",
        id: "call_glob_0",
        name: "glob",
        input: { pattern: "*" },
        providerMeta: { thoughtSignature: "tsig-1" },
      },
    ]);
    // The thought part never leaks into visible text blocks.
    expect(r.content.some((b) => b.type === "text")).toBe(false);
  });

  test("echoes the signature verbatim on the functionCall part next request", async () => {
    let body: Record<string, unknown> = {};
    const fetcher = async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return geminiReply([{ text: "done" }]);
    };
    const history: readonly Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_glob_0",
            name: "glob",
            input: { pattern: "*" },
            providerMeta: { thoughtSignature: "tsig-1" },
          },
        ],
      },
      { role: "tool_result", toolUseId: "call_glob_0", content: "0 files", isError: false },
    ];
    await new GoogleProvider(fetcher).chat(history, [], {
      model: "gemini-3.1-pro-preview",
      apiKey: "k",
    });
    const contents = body.contents as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    const modelTurn = contents.find((c) => c.role === "model");
    expect(modelTurn?.parts[0]).toEqual({
      functionCall: { name: "glob", args: { pattern: "*" } },
      thoughtSignature: "tsig-1",
    });
  });

  test("calls without a signature serialise exactly as before (2.5 family unaffected)", async () => {
    let body: Record<string, unknown> = {};
    const fetcher = async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return geminiReply([{ text: "ok" }]);
    };
    const history: readonly Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_grep_0", name: "grep", input: { pattern: "x" } }],
      },
      { role: "tool_result", toolUseId: "call_grep_0", content: "hit", isError: false },
    ];
    await new GoogleProvider(fetcher).chat(history, [], { model: "gemini-2.5-flash", apiKey: "k" });
    const contents = body.contents as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    const modelTurn = contents.find((c) => c.role === "model");
    expect(modelTurn?.parts[0]).toEqual({ functionCall: { name: "grep", args: { pattern: "x" } } });
    expect("thoughtSignature" in (modelTurn?.parts[0] ?? {})).toBe(false);
  });
});
