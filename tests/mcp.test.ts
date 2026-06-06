/**
 * Unit tests for the MCP client and tool adapter.
 *
 * ADR 0001 §7.6 (faithful MCP) + ADR 0003 (MCP output is untrusted).
 *
 * An in-memory fake `McpTransport` is used throughout — no real subprocess is
 * spawned. The fake scripts exact JSON-RPC response payloads so each case
 * exercises the client's correlation + parsing logic in isolation.
 */

import { describe, test, expect } from "bun:test";
import { McpClient } from "../src/mcp/client.ts";
import { mcpToolToAlfredTool } from "../src/mcp/toolAdapter.ts";
import type { McpTransport } from "../src/mcp/types.ts";

// ---------------------------------------------------------------------------
// Fake in-memory transport
// ---------------------------------------------------------------------------

/**
 * Build a fake transport that:
 *   - Captures outbound messages in `sent`.
 *   - Allows tests to inject inbound messages via `deliver(json)`.
 */
function fakeTransport(): {
  transport: McpTransport;
  sent: string[];
  deliver: (json: string) => void;
  closed: boolean;
} {
  const sent: string[] = [];
  let listener: ((json: string) => void) | null = null;
  let closed = false;

  const transport: McpTransport = {
    send(json: string): void {
      sent.push(json);
    },
    onMessage(cb: (json: string) => void): void {
      listener = cb;
    },
    close(): void {
      closed = true;
    },
  };

  const deliver = (json: string): void => {
    if (listener !== null) listener(json);
  };

  // Return a proxy so tests can toggle `closed` after the fact.
  const state = { transport, sent, deliver, get closed() { return closed; } };
  return state;
}

// ---------------------------------------------------------------------------
// Helper: respond to the next outbound message automatically
// ---------------------------------------------------------------------------

/**
 * Wire up the fake so that every sent message triggers a scripted response.
 * `responder` receives the parsed request and returns the JSON-RPC `result`
 * payload (or throws to simulate a JSON-RPC error response).
 */
function autoRespond(
  fake: ReturnType<typeof fakeTransport>,
  responder: (req: Record<string, unknown>) => unknown,
): void {
  const originalSend = fake.transport.send.bind(fake.transport);
  fake.transport.send = (json: string) => {
    originalSend(json);
    const req = JSON.parse(json) as Record<string, unknown>;
    // Notifications have no id — ignore them.
    if (!("id" in req)) return;
    try {
      const result = responder(req);
      const response = JSON.stringify({
        jsonrpc: "2.0",
        id: req["id"],
        result,
      });
      fake.deliver(response);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const error = JSON.stringify({
        jsonrpc: "2.0",
        id: req["id"],
        error: { code: -32000, message },
      });
      fake.deliver(error);
    }
  };
}

// ---------------------------------------------------------------------------
// Tests: initialize
// ---------------------------------------------------------------------------

describe("McpClient.initialize", () => {
  test("sends initialize request and a notifications/initialized notification", async () => {
    const fake = fakeTransport();
    autoRespond(fake, (req) => {
      if (req["method"] === "initialize") {
        return { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "test", version: "0.0.1" } };
      }
      return {};
    });

    const client = new McpClient(fake.transport);
    await client.initialize();

    const parsed = fake.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    const initReq = parsed.find((m) => m["method"] === "initialize");
    const initNotif = parsed.find((m) => m["method"] === "notifications/initialized");

    expect(initReq).toBeDefined();
    expect(initNotif).toBeDefined();
    // notifications must not have an id
    expect("id" in (initNotif!)).toBe(false);
  });

  test("initialize request carries the correct protocolVersion", async () => {
    const fake = fakeTransport();
    autoRespond(fake, () => ({
      protocolVersion: "2024-11-05",
      capabilities: {},
      serverInfo: { name: "s", version: "1" },
    }));

    const client = new McpClient(fake.transport);
    await client.initialize();

    const parsed = fake.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    const initReq = parsed.find((m) => m["method"] === "initialize") as Record<string, unknown>;
    const params = initReq["params"] as Record<string, unknown>;
    expect(params["protocolVersion"]).toBe("2024-11-05");
  });
});

// ---------------------------------------------------------------------------
// Tests: listTools
// ---------------------------------------------------------------------------

describe("McpClient.listTools", () => {
  test("parses a tools list from the server", async () => {
    const fake = fakeTransport();
    autoRespond(fake, (req) => {
      if (req["method"] === "initialize") {
        return { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "s", version: "1" } };
      }
      if (req["method"] === "tools/list") {
        return {
          tools: [
            {
              name: "read_file",
              description: "Read a file from disk",
              inputSchema: { type: "object", properties: { path: { type: "string" } } },
            },
            {
              name: "write_file",
              description: "Write content to a file",
              inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
            },
          ],
        };
      }
      return {};
    });

    const client = new McpClient(fake.transport);
    await client.initialize();
    const tools = await client.listTools();

    expect(tools).toHaveLength(2);
    expect(tools[0]!.name).toBe("read_file");
    expect(tools[0]!.description).toBe("Read a file from disk");
    expect(tools[0]!.inputSchema).toMatchObject({ type: "object" });
    expect(tools[1]!.name).toBe("write_file");
  });

  test("returns empty array when tools key is missing", async () => {
    const fake = fakeTransport();
    autoRespond(fake, (req) => {
      if (req["method"] === "initialize") return { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "s", version: "1" } };
      return {}; // no `tools` key
    });

    const client = new McpClient(fake.transport);
    await client.initialize();
    const tools = await client.listTools();

    expect(tools).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: callTool
// ---------------------------------------------------------------------------

describe("McpClient.callTool", () => {
  test("flattens content array to text and returns isError=false", async () => {
    const fake = fakeTransport();
    autoRespond(fake, (req) => {
      if (req["method"] === "initialize") return { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "s", version: "1" } };
      if (req["method"] === "tools/call") {
        return {
          content: [
            { type: "text", text: "Hello" },
            { type: "text", text: "World" },
          ],
          isError: false,
        };
      }
      return {};
    });

    const client = new McpClient(fake.transport);
    await client.initialize();
    const result = await client.callTool("greet", { name: "Alfred" });

    expect(result.text).toBe("Hello\nWorld");
    expect(result.isError).toBe(false);
  });

  test("returns isError=true when server signals an error", async () => {
    const fake = fakeTransport();
    autoRespond(fake, (req) => {
      if (req["method"] === "initialize") return { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "s", version: "1" } };
      if (req["method"] === "tools/call") {
        return {
          content: [{ type: "text", text: "Something went wrong" }],
          isError: true,
        };
      }
      return {};
    });

    const client = new McpClient(fake.transport);
    await client.initialize();
    const result = await client.callTool("boom", {});

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Something went wrong");
  });

  test("sends the correct method and tool name in the request", async () => {
    const fake = fakeTransport();
    autoRespond(fake, (req) => {
      if (req["method"] === "initialize") return { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "s", version: "1" } };
      return { content: [{ type: "text", text: "ok" }], isError: false };
    });

    const client = new McpClient(fake.transport);
    await client.initialize();
    await client.callTool("my_tool", { x: 1 });

    const parsed = fake.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    const callReq = parsed.find((m) => m["method"] === "tools/call") as Record<string, unknown>;
    expect(callReq).toBeDefined();
    const params = callReq["params"] as Record<string, unknown>;
    expect(params["name"]).toBe("my_tool");
    expect((params["arguments"] as Record<string, unknown>)["x"]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: JSON-RPC error propagation
// ---------------------------------------------------------------------------

describe("McpClient JSON-RPC error handling", () => {
  test("rejects the promise when the server returns a JSON-RPC error", async () => {
    const fake = fakeTransport();
    autoRespond(fake, (req) => {
      if (req["method"] === "initialize") return { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "s", version: "1" } };
      if (req["method"] === "tools/list") {
        throw new Error("Method not found");
      }
      return {};
    });

    const client = new McpClient(fake.transport);
    await client.initialize();

    await expect(client.listTools()).rejects.toThrow("Method not found");
  });

  test("includes the RPC error code in the rejection message", async () => {
    const fake = fakeTransport();

    // Bypass autoRespond — craft the error payload manually.
    let capturedId: unknown = null;
    fake.transport.send = (json: string) => {
      const req = JSON.parse(json) as Record<string, unknown>;
      if (!("id" in req)) return;
      capturedId = req["id"];
      const errResponse = JSON.stringify({
        jsonrpc: "2.0",
        id: capturedId,
        error: { code: -32601, message: "Method not found" },
      });
      fake.deliver(errResponse);
    };

    const client = new McpClient(fake.transport);
    await expect(client.initialize()).rejects.toThrow("-32601");
  });
});

// ---------------------------------------------------------------------------
// Tests: tool adapter
// ---------------------------------------------------------------------------

describe("mcpToolToAlfredTool", () => {
  function makeClientWithCallResult(text: string, isError: boolean): McpClient {
    const fake = fakeTransport();
    autoRespond(fake, (req) => {
      if (req["method"] === "initialize") return { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "s", version: "1" } };
      if (req["method"] === "tools/call") {
        return { content: [{ type: "text", text }], isError };
      }
      return {};
    });
    return new McpClient(fake.transport);
  }

  test("prefixes the tool name with mcp__", () => {
    const client = makeClientWithCallResult("ok", false);
    const tool = mcpToolToAlfredTool(client, {
      name: "search",
      description: "Search something",
      inputSchema: {},
    });
    expect(tool.name).toBe("mcp__search");
  });

  test("adapted tool result has untrusted=true (ADR 0003)", async () => {
    const client = makeClientWithCallResult("some result", false);
    await client.initialize();

    const tool = mcpToolToAlfredTool(client, {
      name: "read_file",
      description: "Read a file",
      inputSchema: { type: "object" },
    });

    const ctx = {
      workingDir: "/tmp",
      signal: new AbortController().signal,
      readFileState: new Map(),
      permissions: {
        mode: "default" as const,
        allowedTools: new Set<string>(),
        deniedTools: new Set<string>(),
        workingDir: "/tmp",
      },
    };

    const result = await tool.call({ path: "/tmp/test.txt" }, ctx);
    expect(result.untrusted).toBe(true);
  });

  test("adapted tool propagates isError from callTool", async () => {
    const client = makeClientWithCallResult("oops", true);
    await client.initialize();

    const tool = mcpToolToAlfredTool(client, {
      name: "boom",
      description: "Always errors",
      inputSchema: {},
    });

    const ctx = {
      workingDir: "/tmp",
      signal: new AbortController().signal,
      readFileState: new Map(),
      permissions: {
        mode: "default" as const,
        allowedTools: new Set<string>(),
        deniedTools: new Set<string>(),
        workingDir: "/tmp",
      },
    };

    const result = await tool.call({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.untrusted).toBe(true);
  });

  test("checkPermissions returns ask behavior", async () => {
    const client = makeClientWithCallResult("ok", false);
    const tool = mcpToolToAlfredTool(client, {
      name: "dangerous",
      description: "Needs approval",
      inputSchema: {},
    });

    const permCtx = {
      mode: "default" as const,
      allowedTools: new Set<string>(),
      deniedTools: new Set<string>(),
      workingDir: "/tmp",
    };

    const perm = await tool.checkPermissions({}, permCtx);
    expect(perm.behavior).toBe("ask");
  });

  test("description embeds the JSON schema when non-empty", () => {
    const client = makeClientWithCallResult("ok", false);
    const schema = { type: "object", properties: { path: { type: "string" } } };
    const tool = mcpToolToAlfredTool(client, {
      name: "read_file",
      description: "Read a file",
      inputSchema: schema,
    });

    expect(tool.description).toContain("Input schema");
    expect(tool.description).toContain(JSON.stringify(schema));
  });

  test("content text is returned as the result content", async () => {
    const client = makeClientWithCallResult("file contents here", false);
    await client.initialize();

    const tool = mcpToolToAlfredTool(client, {
      name: "read_file",
      description: "Read a file",
      inputSchema: {},
    });

    const ctx = {
      workingDir: "/tmp",
      signal: new AbortController().signal,
      readFileState: new Map(),
      permissions: {
        mode: "default" as const,
        allowedTools: new Set<string>(),
        deniedTools: new Set<string>(),
        workingDir: "/tmp",
      },
    };

    const result = await tool.call({ path: "/tmp/foo.txt" }, ctx);
    expect(result.content).toBe("file contents here");
  });
});

// ---------------------------------------------------------------------------
// Tests: request timeout (a dead server must not hang the agent)
// ---------------------------------------------------------------------------

describe("McpClient request timeout", () => {
  test("rejects a request when the server never responds", async () => {
    const fake = fakeTransport(); // no autoRespond → nothing ever comes back
    const client = new McpClient(fake.transport, { requestTimeoutMs: 20 });
    await expect(client.initialize()).rejects.toThrow(/timed out/);
  });

  test("does not time out when the server responds in time", async () => {
    const fake = fakeTransport();
    autoRespond(fake, () => ({
      protocolVersion: "2024-11-05",
      capabilities: {},
      serverInfo: { name: "s", version: "1" },
    }));
    const client = new McpClient(fake.transport, { requestTimeoutMs: 1000 });
    await expect(client.initialize()).resolves.toBeUndefined();
  });
});
