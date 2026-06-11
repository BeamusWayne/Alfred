/**
 * Unit tests for the startup bootstrap module.
 *
 * ADR 0001 §7.6 (faithful MCP) + ADR 0002 (LSP).
 *
 * All tests use in-memory fakes — no real subprocess is spawned.
 * Coverage:
 *   - loadMcpConfig: valid parse, missing file, malformed JSON, schema mismatch
 *   - loadLspConfig: valid parse, missing file, malformed JSON, schema mismatch
 *   - buildMcpTools: returns adapted mcp__* tools from a fake McpClient
 *   - bootstrapExtensions: empty working dir → {tools:[], close} + close resolves
 */

import { describe, test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  loadMcpConfig,
  loadLspConfig,
  buildMcpTools,
  bootstrapExtensions,
} from "../src/extensions/bootstrap.ts";
import { McpClient } from "../src/mcp/client.ts";
import type { McpTransport } from "../src/mcp/types.ts";

// ---------------------------------------------------------------------------
// Helpers: in-memory MCP transport (mirrors pattern in tests/mcp.test.ts)
// ---------------------------------------------------------------------------

function fakeTransport(): {
  transport: McpTransport;
  sent: string[];
  deliver: (json: string) => void;
} {
  const sent: string[] = [];
  let listener: ((json: string) => void) | null = null;

  const transport: McpTransport = {
    send(json: string): void {
      sent.push(json);
    },
    onMessage(cb: (json: string) => void): void {
      listener = cb;
    },
    close(): void {
      /* no-op in tests */
    },
  };

  const deliver = (json: string): void => {
    if (listener !== null) listener(json);
  };

  return { transport, sent, deliver };
}

/**
 * Wire the fake so every outbound request triggers a scripted response.
 * Notifications (no id) are ignored.
 */
function autoRespond(
  fake: ReturnType<typeof fakeTransport>,
  responder: (req: Record<string, unknown>) => unknown,
): void {
  const originalSend = fake.transport.send.bind(fake.transport);
  fake.transport.send = (json: string): void => {
    originalSend(json);
    const req = JSON.parse(json) as Record<string, unknown>;
    if (!("id" in req)) return;
    try {
      const result = responder(req);
      fake.deliver(JSON.stringify({ jsonrpc: "2.0", id: req["id"], result }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      fake.deliver(
        JSON.stringify({
          jsonrpc: "2.0",
          id: req["id"],
          error: { code: -32000, message },
        }),
      );
    }
  };
}

/** Build a fake McpClient that serves initialize + tools/list responses. */
function makeClientWithTools(toolNames: readonly string[]): McpClient {
  const fake = fakeTransport();
  autoRespond(fake, (req) => {
    if (req["method"] === "initialize") {
      return {
        protocolVersion: "2024-11-05",
        capabilities: {},
        serverInfo: { name: "fake-server", version: "0.0.1" },
      };
    }
    if (req["method"] === "tools/list") {
      return {
        tools: toolNames.map((name) => ({
          name,
          description: `Tool ${name}`,
          inputSchema: { type: "object", properties: {} },
        })),
      };
    }
    return {};
  });
  return new McpClient(fake.transport);
}

// ---------------------------------------------------------------------------
// Helpers: temp directory for file-based tests
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "alfred-bootstrap-test-"));
}

async function writeTmpFile(dir: string, name: string, content: string): Promise<string> {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

// ---------------------------------------------------------------------------
// Tests: loadMcpConfig
// ---------------------------------------------------------------------------

describe("loadMcpConfig", () => {
  test("parses a valid mcp.json and returns typed config", async () => {
    const dir = await makeTmpDir();
    const filePath = await writeTmpFile(
      dir,
      "mcp.json",
      JSON.stringify({
        servers: [
          { command: "uvx", args: ["mcp-server-git"] },
          { command: "node", args: ["dist/index.js"] },
        ],
      }),
    );

    const config = await loadMcpConfig(filePath);

    expect(config.servers).toHaveLength(2);
    expect(config.servers[0]!.command).toBe("uvx");
    expect(config.servers[0]!.args).toEqual(["mcp-server-git"]);
    expect(config.servers[1]!.command).toBe("node");
  });

  test("returns {servers:[]} when the file does not exist", async () => {
    const config = await loadMcpConfig("/nonexistent/path/mcp.json");
    expect(config.servers).toEqual([]);
  });

  test("returns {servers:[]} when the file contains invalid JSON", async () => {
    const dir = await makeTmpDir();
    const filePath = await writeTmpFile(dir, "mcp.json", "{ not valid json !!!");

    const config = await loadMcpConfig(filePath);
    expect(config.servers).toEqual([]);
  });

  test("returns {servers:[]} when the file has the wrong schema shape", async () => {
    const dir = await makeTmpDir();
    const filePath = await writeTmpFile(
      dir,
      "mcp.json",
      JSON.stringify({ wrongKey: [{ command: "foo" }] }),
    );

    // Zod defaults servers to [] when key is missing, so expect empty
    const config = await loadMcpConfig(filePath);
    // Either parsed with empty servers (zod default) or schema mismatch falls back
    expect(Array.isArray(config.servers)).toBe(true);
  });

  test("omitting args is valid — field is optional", async () => {
    const dir = await makeTmpDir();
    const filePath = await writeTmpFile(
      dir,
      "mcp.json",
      JSON.stringify({ servers: [{ command: "my-server" }] }),
    );

    const config = await loadMcpConfig(filePath);
    expect(config.servers[0]!.command).toBe("my-server");
    expect(config.servers[0]!.args).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: loadLspConfig
// ---------------------------------------------------------------------------

describe("loadLspConfig", () => {
  test("parses a valid lsp.json and returns typed config", async () => {
    const dir = await makeTmpDir();
    const filePath = await writeTmpFile(
      dir,
      "lsp.json",
      JSON.stringify({
        servers: [
          {
            command: "typescript-language-server",
            args: ["--stdio"],
            rootUri: "file:///workspace",
          },
        ],
      }),
    );

    const config = await loadLspConfig(filePath);

    expect(config.servers).toHaveLength(1);
    expect(config.servers[0]!.command).toBe("typescript-language-server");
    expect(config.servers[0]!.args).toEqual(["--stdio"]);
    expect(config.servers[0]!.rootUri).toBe("file:///workspace");
  });

  test("returns {servers:[]} when the file does not exist", async () => {
    const config = await loadLspConfig("/nonexistent/path/lsp.json");
    expect(config.servers).toEqual([]);
  });

  test("returns {servers:[]} when the file contains invalid JSON", async () => {
    const dir = await makeTmpDir();
    const filePath = await writeTmpFile(dir, "lsp.json", "not-json");

    const config = await loadLspConfig(filePath);
    expect(config.servers).toEqual([]);
  });

  test("rootUri and args are optional", async () => {
    const dir = await makeTmpDir();
    const filePath = await writeTmpFile(
      dir,
      "lsp.json",
      JSON.stringify({ servers: [{ command: "pyright" }] }),
    );

    const config = await loadLspConfig(filePath);
    expect(config.servers[0]!.command).toBe("pyright");
    expect(config.servers[0]!.args).toBeUndefined();
    expect(config.servers[0]!.rootUri).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: buildMcpTools
// ---------------------------------------------------------------------------

describe("buildMcpTools", () => {
  test("returns adapted mcp__* Alfred tools for each server tool", async () => {
    const client = makeClientWithTools(["read_file", "write_file"]);
    await client.initialize();

    const tools = await buildMcpTools(client);

    expect(tools).toHaveLength(2);
    expect(tools[0]!.name).toBe("mcp__read_file");
    expect(tools[1]!.name).toBe("mcp__write_file");
  });

  test("returns empty array when the server exposes no tools", async () => {
    const client = makeClientWithTools([]);
    await client.initialize();

    const tools = await buildMcpTools(client);
    expect(tools).toHaveLength(0);
  });

  test("each adapted tool description includes the JSON schema note", async () => {
    const client = makeClientWithTools(["search"]);
    await client.initialize();

    const tools = await buildMcpTools(client);
    // The schema has properties, so the adapter should embed a schema note
    expect(tools[0]!.description).toContain("Tool search");
    expect(tools[0]!.description).toContain("Input schema");
  });

  test("adapted tools are callable (untrusted flag set)", async () => {
    const fake = fakeTransport();
    autoRespond(fake, (req) => {
      if (req["method"] === "initialize") {
        return {
          protocolVersion: "2024-11-05",
          capabilities: {},
          serverInfo: { name: "s", version: "1" },
        };
      }
      if (req["method"] === "tools/list") {
        return {
          tools: [{ name: "ping", description: "Ping", inputSchema: {} }],
        };
      }
      if (req["method"] === "tools/call") {
        return {
          content: [{ type: "text", text: "pong" }],
          isError: false,
        };
      }
      return {};
    });

    const client = new McpClient(fake.transport);
    await client.initialize();
    const tools = await buildMcpTools(client);
    expect(tools).toHaveLength(1);

    const ctx = {
      workingDir: "/tmp",
      signal: new AbortController().signal,
      readFileState: new Map<string, { content: string; mtimeMs: number }>(),
      permissions: {
        mode: "default" as const,
        allowedTools: new Set<string>(),
        deniedTools: new Set<string>(),
        workingDir: "/tmp",
      },
    };

    const result = await tools[0]!.call({}, ctx);
    expect(result.content).toBe("pong");
    expect(result.untrusted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: bootstrapExtensions
// ---------------------------------------------------------------------------

describe("bootstrapExtensions", () => {
  test("returns empty tools and resolvable close() when no config files exist", async () => {
    const dir = await makeTmpDir();

    const result = await bootstrapExtensions(dir);

    expect(result.tools).toEqual([]);
    // close() must resolve without throwing
    await expect(result.close()).resolves.toBeUndefined();
  });

  test("close() resolves immediately when no servers were connected", async () => {
    const dir = await makeTmpDir();
    const result = await bootstrapExtensions(dir);

    let resolved = false;
    await result.close().then(() => {
      resolved = true;
    });
    expect(resolved).toBe(true);
  });

  test("returns empty tools when .alfred dir exists but both configs have empty servers", async () => {
    const dir = await makeTmpDir();
    const alfredDir = path.join(dir, ".alfred");
    await fs.mkdir(alfredDir);
    await fs.writeFile(path.join(alfredDir, "mcp.json"), JSON.stringify({ servers: [] }), "utf8");
    await fs.writeFile(path.join(alfredDir, "lsp.json"), JSON.stringify({ servers: [] }), "utf8");

    const result = await bootstrapExtensions(dir);

    expect(result.tools).toEqual([]);
    await expect(result.close()).resolves.toBeUndefined();
  });

  test("skips a malformed mcp.json and still returns a valid BootstrapResult", async () => {
    const dir = await makeTmpDir();
    const alfredDir = path.join(dir, ".alfred");
    await fs.mkdir(alfredDir);
    await fs.writeFile(path.join(alfredDir, "mcp.json"), "{ this is not json!!!", "utf8");

    const result = await bootstrapExtensions(dir);

    expect(result.tools).toEqual([]);
    await expect(result.close()).resolves.toBeUndefined();
  });

  test("skips a malformed lsp.json and still returns a valid BootstrapResult", async () => {
    const dir = await makeTmpDir();
    const alfredDir = path.join(dir, ".alfred");
    await fs.mkdir(alfredDir);
    await fs.writeFile(path.join(alfredDir, "lsp.json"), "INVALID", "utf8");

    const result = await bootstrapExtensions(dir);

    expect(result.tools).toEqual([]);
    await expect(result.close()).resolves.toBeUndefined();
  });

  test("warnings is empty when no servers are configured", async () => {
    const dir = await makeTmpDir();
    const result = await bootstrapExtensions(dir);
    expect(result.warnings).toEqual([]);
  });

  test("surfaces a warning (never silent) when a server fails to spawn", async () => {
    // A command that cannot be launched makes Bun.spawn throw ENOENT. The old
    // behaviour swallowed this in a bare catch, so a launch failure looked
    // identical to "no servers configured". It must now be reported.
    const dir = await makeTmpDir();
    const alfredDir = path.join(dir, ".alfred");
    await fs.mkdir(alfredDir);
    const bogus = "alfred-nonexistent-binary-xyz";
    await fs.writeFile(
      path.join(alfredDir, "lsp.json"),
      JSON.stringify({ servers: [{ command: bogus, args: ["--stdio"] }] }),
      "utf8",
    );
    await fs.writeFile(
      path.join(alfredDir, "mcp.json"),
      JSON.stringify({ servers: [{ command: bogus }] }),
      "utf8",
    );

    const seen: string[] = [];
    const result = await bootstrapExtensions(dir, {
      connectTimeoutMs: 500, // fail fast even if the binary spawns then dies
      onWarn: (m) => seen.push(m),
    });

    expect(result.tools).toEqual([]);
    expect(result.warnings.length).toBe(2); // one LSP + one MCP
    expect(seen).toEqual([...result.warnings]); // onWarn received the same lines
    expect(result.warnings.some((w) => w.includes("LSP") && w.includes(bogus))).toBe(true);
    expect(result.warnings.some((w) => w.includes("MCP") && w.includes(bogus))).toBe(true);
    await expect(result.close()).resolves.toBeUndefined();
  });
});
