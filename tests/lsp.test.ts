/**
 * Unit tests for the LSP client module.
 *
 * ADR 0002 (LSP client — IDE-grade code intelligence).
 *
 * All tests use an in-memory fake `LspTransport` that scripts server responses
 * synchronously — no real language server process is required.
 *
 * Coverage:
 *   - initialize handshake (request + initialized notification)
 *   - definition / references parse Location[]
 *   - hover extracts display text from various response shapes
 *   - publishDiagnostics notification is captured; diagnostics(uri) returns it
 *   - createFrameParser reassembles a Content-Length-framed message correctly
 *   - createFrameParser handles a message split across two chunks
 *   - lsp_definition tool returns compact formatted output
 */

import { describe, test, expect } from "bun:test";
import { LspClient } from "../src/tools/lsp/client.ts";
import { makeLspTools } from "../src/tools/lsp/tools.ts";
import { encodeMessage, createFrameParser } from "../src/tools/lsp/protocol.ts";
import type { LspTransport } from "../src/tools/lsp/protocol.ts";

// ---------------------------------------------------------------------------
// In-memory fake transport
// ---------------------------------------------------------------------------

interface FakeTransport extends LspTransport {
  /** All raw JSON strings sent by the client (after framing is stripped). */
  readonly sent: string[];
  /** Deliver a raw JSON string to the registered message listener. */
  deliver(json: string): void;
}

function makeFakeTransport(): FakeTransport {
  const sent: string[] = [];
  let listener: ((json: string) => void) | null = null;

  return {
    sent,
    send(json: string): void {
      sent.push(json);
    },
    onMessage(cb: (json: string) => void): void {
      listener = cb;
    },
    close(): void { /* no-op in tests */ },
    deliver(json: string): void {
      if (listener !== null) listener(json);
    },
  };
}

/** Build a JSON-RPC 2.0 success response for the given request id. */
function successResponse(id: number, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse the last JSON string sent by the client. */
function lastSent(t: FakeTransport): Record<string, unknown> {
  const raw = t.sent[t.sent.length - 1];
  if (raw === undefined) throw new Error("no messages sent");
  return JSON.parse(raw) as Record<string, unknown>;
}

/**
 * Wait until the client has sent a request (a message with both `method` and
 * `id`) for `method`, then return it. The LSP tools open the document first via
 * an async file read, so the query request is not sent synchronously from
 * `call()` — polling the microtask queue is the robust way to catch it.
 */
async function waitForRequest(
  t: FakeTransport,
  method: string,
  maxTicks = 50,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < maxTicks; i++) {
    for (let j = t.sent.length - 1; j >= 0; j--) {
      const msg = JSON.parse(t.sent[j]!) as Record<string, unknown>;
      if (msg["method"] === method && "id" in msg) return msg;
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`request "${method}" was not sent within ${maxTicks} ticks`);
}

// ---------------------------------------------------------------------------
// Tests: encodeMessage / createFrameParser
// ---------------------------------------------------------------------------

describe("encodeMessage + createFrameParser", () => {
  test("round-trips a single message in one chunk", () => {
    const obj = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
    const framed = encodeMessage(obj);

    const received: string[] = [];
    const consume = createFrameParser((json) => received.push(json));
    consume(framed);

    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!)).toEqual(obj);
  });

  test("reassembles a message split across two chunks", () => {
    const obj = { jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: "file:///a.ts", diagnostics: [] } };
    const framed = encodeMessage(obj);

    // Split somewhere in the middle of the body
    const mid = Math.floor(framed.length / 2);
    const chunk1 = framed.slice(0, mid);
    const chunk2 = framed.slice(mid);

    const received: string[] = [];
    const consume = createFrameParser((json) => received.push(json));
    consume(chunk1);
    expect(received).toHaveLength(0); // not yet complete
    consume(chunk2);
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!)).toEqual(obj);
  });

  test("handles two consecutive messages in a single chunk", () => {
    const msg1 = { jsonrpc: "2.0", id: 1, result: "ok" };
    const msg2 = { jsonrpc: "2.0", id: 2, result: "done" };
    const framed = encodeMessage(msg1) + encodeMessage(msg2);

    const received: string[] = [];
    const consume = createFrameParser((json) => received.push(json));
    consume(framed);

    expect(received).toHaveLength(2);
    expect(JSON.parse(received[0]!)).toEqual(msg1);
    expect(JSON.parse(received[1]!)).toEqual(msg2);
  });

  test("frames on byte length, not character count, for multi-byte UTF-8", () => {
    // Content-Length is a UTF-8 byte count. This body's byte length exceeds its
    // JS string length, so slicing the decoded string by that number would
    // over-read and desync the following frame. Byte-accurate framing keeps
    // both intact — and we feed raw Uint8Array chunks split mid-character, the
    // exact shape the stdio transport delivers from the OS pipe.
    const msg1 = { jsonrpc: "2.0", id: 1, result: { value: "café — 日本語 🚀" } };
    const msg2 = { jsonrpc: "2.0", id: 2, result: "next" };
    const bytes = new TextEncoder().encode(encodeMessage(msg1) + encodeMessage(msg2));

    const received: string[] = [];
    const consume = createFrameParser((json) => received.push(json));

    // 0x9F is a UTF-8 continuation byte inside 🚀 (F0 9F 9A 80) — splitting
    // here lands in the middle of a multi-byte character.
    const cut = bytes.indexOf(0x9f);
    const at = cut > 0 ? cut : Math.floor(bytes.length / 2);
    consume(bytes.subarray(0, at));
    consume(bytes.subarray(at));

    expect(received).toHaveLength(2);
    expect(JSON.parse(received[0]!)).toEqual(msg1);
    expect(JSON.parse(received[1]!)).toEqual(msg2);
  });
});

// ---------------------------------------------------------------------------
// Tests: LspClient request timeout (a dead server must not hang the agent)
// ---------------------------------------------------------------------------

describe("LspClient request timeout", () => {
  test("rejects a request when the server never responds", async () => {
    const t = makeFakeTransport();
    const client = new LspClient(t, { requestTimeoutMs: 20 });
    // The fake never delivers a response → the timeout must fire.
    await expect(client.initialize("file:///workspace")).rejects.toThrow(/timed out/);
  });

  test("does not time out when the server responds in time", async () => {
    const t = makeFakeTransport();
    const client = new LspClient(t, { requestTimeoutMs: 1000 });
    const p = client.initialize("file:///workspace");
    t.deliver(successResponse(1, { capabilities: {} }));
    await expect(p).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: LspClient initialize
// ---------------------------------------------------------------------------

describe("LspClient.initialize", () => {
  test("sends initialize request then initialized notification", async () => {
    const t = makeFakeTransport();
    const client = new LspClient(t);

    const initPromise = client.initialize("file:///workspace");

    // Server responds to initialize (id=1)
    const req = JSON.parse(t.sent[0]!) as Record<string, unknown>;
    expect(req["method"]).toBe("initialize");
    expect(req["id"]).toBe(1);

    t.deliver(successResponse(1, { capabilities: {} }));
    await initPromise;

    // Client should have sent the `initialized` notification after the response
    const notification = JSON.parse(t.sent[1]!) as Record<string, unknown>;
    expect(notification["method"]).toBe("initialized");
    expect(notification["id"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: definition
// ---------------------------------------------------------------------------

describe("LspClient.definition", () => {
  test("returns Location[] parsed from server response", async () => {
    const t = makeFakeTransport();
    const client = new LspClient(t);

    // bootstrap: initialize
    const initP = client.initialize("file:///ws");
    t.deliver(successResponse(1, { capabilities: {} }));
    await initP;

    const defPromise = client.definition("file:///ws/src/foo.ts", { line: 10, character: 5 });

    const defReq = lastSent(t);
    expect(defReq["method"]).toBe("textDocument/definition");
    const params = defReq["params"] as Record<string, unknown>;
    expect((params["textDocument"] as Record<string, unknown>)["uri"]).toBe("file:///ws/src/foo.ts");
    expect(params["position"]).toEqual({ line: 10, character: 5 });

    t.deliver(
      successResponse(defReq["id"] as number, [
        { uri: "file:///ws/src/bar.ts", range: { start: { line: 3, character: 0 }, end: { line: 3, character: 10 } } },
      ]),
    );

    const locs = await defPromise;
    expect(locs).toHaveLength(1);
    expect(locs[0]!.uri).toBe("file:///ws/src/bar.ts");
    expect(locs[0]!.range.start.line).toBe(3);
  });

  test("returns empty array for null result", async () => {
    const t = makeFakeTransport();
    const client = new LspClient(t);
    const initP = client.initialize("file:///ws");
    t.deliver(successResponse(1, { capabilities: {} }));
    await initP;

    const defP = client.definition("file:///ws/a.ts", { line: 0, character: 0 });
    const req = lastSent(t);
    t.deliver(successResponse(req["id"] as number, null));

    const locs = await defP;
    expect(locs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: references
// ---------------------------------------------------------------------------

describe("LspClient.references", () => {
  test("returns multiple locations", async () => {
    const t = makeFakeTransport();
    const client = new LspClient(t);
    const initP = client.initialize("file:///ws");
    t.deliver(successResponse(1, { capabilities: {} }));
    await initP;

    const refP = client.references("file:///ws/index.ts", { line: 0, character: 0 });
    const req = lastSent(t);
    expect(req["method"]).toBe("textDocument/references");

    t.deliver(
      successResponse(req["id"] as number, [
        { uri: "file:///ws/a.ts", range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } } },
        { uri: "file:///ws/b.ts", range: { start: { line: 5, character: 0 }, end: { line: 5, character: 6 } } },
      ]),
    );

    const locs = await refP;
    expect(locs).toHaveLength(2);
    expect(locs[0]!.uri).toBe("file:///ws/a.ts");
    expect(locs[1]!.uri).toBe("file:///ws/b.ts");
  });
});

// ---------------------------------------------------------------------------
// Tests: hover
// ---------------------------------------------------------------------------

describe("LspClient.hover", () => {
  test("extracts string from MarkupContent", async () => {
    const t = makeFakeTransport();
    const client = new LspClient(t);
    const initP = client.initialize("file:///ws");
    t.deliver(successResponse(1, { capabilities: {} }));
    await initP;

    const hoverP = client.hover("file:///ws/index.ts", { line: 2, character: 4 });
    const req = lastSent(t);
    expect(req["method"]).toBe("textDocument/hover");

    t.deliver(successResponse(req["id"] as number, { contents: { kind: "markdown", value: "```ts\nconst x: number\n```" } }));

    const text = await hoverP;
    expect(text).toBe("```ts\nconst x: number\n```");
  });

  test("extracts plain string contents", async () => {
    const t = makeFakeTransport();
    const client = new LspClient(t);
    const initP = client.initialize("file:///ws");
    t.deliver(successResponse(1, { capabilities: {} }));
    await initP;

    const hoverP = client.hover("file:///ws/index.ts", { line: 0, character: 0 });
    const req = lastSent(t);
    t.deliver(successResponse(req["id"] as number, { contents: "myFunction(): void" }));

    const text = await hoverP;
    expect(text).toBe("myFunction(): void");
  });

  test("returns null for null result", async () => {
    const t = makeFakeTransport();
    const client = new LspClient(t);
    const initP = client.initialize("file:///ws");
    t.deliver(successResponse(1, { capabilities: {} }));
    await initP;

    const hoverP = client.hover("file:///ws/index.ts", { line: 0, character: 0 });
    const req = lastSent(t);
    t.deliver(successResponse(req["id"] as number, null));

    const text = await hoverP;
    expect(text).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: publishDiagnostics notification
// ---------------------------------------------------------------------------

describe("LspClient diagnostics (publishDiagnostics)", () => {
  test("captures diagnostics from server notification", async () => {
    const t = makeFakeTransport();
    const client = new LspClient(t);
    const initP = client.initialize("file:///ws");
    t.deliver(successResponse(1, { capabilities: {} }));
    await initP;

    const uri = "file:///ws/src/main.ts";
    expect(client.diagnostics(uri)).toEqual([]); // nothing yet

    // Server sends publishDiagnostics notification (no id)
    t.deliver(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri,
          diagnostics: [
            {
              range: { start: { line: 4, character: 2 }, end: { line: 4, character: 10 } },
              severity: 1,
              message: "Cannot find name 'foo'.",
              source: "ts",
            },
          ],
        },
      }),
    );

    const diags = client.diagnostics(uri);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toBe("Cannot find name 'foo'.");
    expect(diags[0]!.severity).toBe(1);
    expect(diags[0]!.source).toBe("ts");
    expect(diags[0]!.range.start.line).toBe(4);
  });

  test("clears diagnostics when server sends empty list", async () => {
    const t = makeFakeTransport();
    const client = new LspClient(t);
    const initP = client.initialize("file:///ws");
    t.deliver(successResponse(1, { capabilities: {} }));
    await initP;

    const uri = "file:///ws/clean.ts";
    t.deliver(JSON.stringify({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 2, message: "warning" }] } }));
    expect(client.diagnostics(uri)).toHaveLength(1);

    t.deliver(JSON.stringify({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } }));
    expect(client.diagnostics(uri)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: lsp_definition tool (integration of tools.ts)
// ---------------------------------------------------------------------------

describe("lsp_definition tool", () => {
  test("formats locations as path:line:char", async () => {
    const t = makeFakeTransport();
    const client = new LspClient(t);
    const initP = client.initialize("file:///ws");
    t.deliver(successResponse(1, { capabilities: {} }));
    await initP;

    const tools = makeLspTools(client);
    const defTool = tools.find((tool) => tool.name === "lsp_definition");
    expect(defTool).toBeDefined();

    const ctx = {
      workingDir: "/ws",
      signal: new AbortController().signal,
      readFileState: new Map(),
      permissions: { mode: "default" as const, allowedTools: new Set<string>(), deniedTools: new Set<string>(), workingDir: "/ws" },
    };

    const callPromise = defTool!.call({ path: "/ws/src/index.ts", line: 5, character: 3 }, ctx);

    // The tool converts path to file URI and calls client.definition — respond
    const defReq = await waitForRequest(t, "textDocument/definition");
    t.deliver(
      successResponse(defReq["id"] as number, [
        { uri: "file:///ws/lib/utils.ts", range: { start: { line: 11, character: 0 }, end: { line: 11, character: 12 } } },
      ]),
    );

    const result = await callPromise;
    expect(result.isError).toBeFalsy();
    // 0-based line 11 → display as 12
    expect(result.content).toBe("/ws/lib/utils.ts:12:1");
  });

  test("returns (no results) when location list is empty", async () => {
    const t = makeFakeTransport();
    const client = new LspClient(t);
    const initP = client.initialize("file:///ws");
    t.deliver(successResponse(1, { capabilities: {} }));
    await initP;

    const tools = makeLspTools(client);
    const defTool = tools.find((tool) => tool.name === "lsp_definition")!;

    const ctx = {
      workingDir: "/ws",
      signal: new AbortController().signal,
      readFileState: new Map(),
      permissions: { mode: "default" as const, allowedTools: new Set<string>(), deniedTools: new Set<string>(), workingDir: "/ws" },
    };

    const callP = defTool.call({ path: "/ws/src/index.ts", line: 0, character: 0 }, ctx);
    const req = await waitForRequest(t, "textDocument/definition");
    t.deliver(successResponse(req["id"] as number, null));

    const result = await callP;
    expect(result.content).toBe("(no results)");
  });

  test("isReadOnly returns true", () => {
    const t = makeFakeTransport();
    const client = new LspClient(t);
    const tools = makeLspTools(client);
    const defTool = tools.find((tool) => tool.name === "lsp_definition")!;
    expect(defTool.isReadOnly({ path: "/a", line: 0, character: 0 })).toBe(true);
  });

  test("isConcurrencySafe returns true", () => {
    const t = makeFakeTransport();
    const client = new LspClient(t);
    const tools = makeLspTools(client);
    const hoverTool = tools.find((tool) => tool.name === "lsp_hover")!;
    expect(hoverTool.isConcurrencySafe({ path: "/a", line: 0, character: 0 })).toBe(true);
  });

  test("checkPermissions returns allow", async () => {
    const t = makeFakeTransport();
    const client = new LspClient(t);
    const tools = makeLspTools(client);
    const refTool = tools.find((tool) => tool.name === "lsp_references")!;
    const perm = await refTool.checkPermissions(
      { path: "/a", line: 0, character: 0 },
      { mode: "default", allowedTools: new Set(), deniedTools: new Set(), workingDir: "/ws" },
    );
    expect(perm.behavior).toBe("allow");
  });
});
