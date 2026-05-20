import { describe, test, expect } from "bun:test";
import type { McpServerConfig } from "../src/mcp/types.js";

describe("MCP types", () => {
  test("McpServerConfig has expected shape", () => {
    const config: McpServerConfig = {
      name: "test-server",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-test"],
      env: { API_KEY: "test-key" },
    };
    expect(config.name).toBe("test-server");
    expect(config.command).toBe("npx");
  });

  test("McpServerConfig with minimal fields", () => {
    const config: McpServerConfig = {
      name: "minimal",
      command: "echo",
    };
    expect(config.args).toBeUndefined();
    expect(config.env).toBeUndefined();
  });
});
