import { describe, test, expect } from "bun:test";
import "../src/commands/index.js";
import { getCommand, getAllCommands, parseCommand } from "../src/commands/index.js";

describe("command parsing", () => {
  test("parses /help", () => {
    expect(parseCommand("/help")).toEqual({ name: "help", args: "" });
  });

  test("parses /model sonnet", () => {
    expect(parseCommand("/model sonnet")).toEqual({ name: "model", args: "sonnet" });
  });

  test("returns null for non-command input", () => {
    expect(parseCommand("hello world")).toBeNull();
    expect(parseCommand("")).toBeNull();
  });
});

describe("command registry", () => {
  test("all built-in commands are registered", () => {
    const names = getAllCommands().map((c) => c.name);
    expect(names).toContain("help");
    expect(names).toContain("clear");
    expect(names).toContain("model");
    expect(names).toContain("cost");
    expect(names).toContain("config");
    expect(names).toContain("compact");
  });

  test("/help returns command list", async () => {
    const cmd = getCommand("help");
    const result = await cmd!.execute("");
    expect(result.type).toBe("text");
    expect(result.content).toContain("Available commands");
  });

  test("/help is accessible via alias ?", async () => {
    const cmd = getCommand("?");
    expect(cmd!.name).toBe("help");
  });

  test("/clear returns clear result", async () => {
    const result = await getCommand("clear")!.execute("");
    expect(result.type).toBe("clear");
  });

  test("/model without args shows usage", async () => {
    const result = await getCommand("model")!.execute("");
    expect(result.type).toBe("text");
    expect(result.content).toContain("Providers:");
  });

  test("/model with args returns model switch", async () => {
    const result = await getCommand("model")!.execute("anthropic/claude-sonnet-4-6");
    expect(result.type).toBe("model");
    if (result.type === "model") {
      expect(result.model).toBe("anthropic/claude-sonnet-4-6");
    }
  });

  test("/cost returns text", async () => {
    const result = await getCommand("cost")!.execute("");
    expect(result.type).toBe("text");
  });

  test("/config without args shows usage", async () => {
    const result = await getCommand("config")!.execute("");
    expect(result.content).toContain("not yet implemented");
  });
});
