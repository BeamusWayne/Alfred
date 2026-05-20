import { describe, test, expect, beforeEach } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { AuthManager } from "../src/auth/manager.js";
import { loginCommand, logoutCommand, setAuthManager } from "../src/commands/auth.js";
import { clearCommands, getCommand } from "../src/commands/types.js";

const TMP_DIR = "/tmp/alfred-auth-test";
let manager: AuthManager;

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
  clearCommands();
  manager = new AuthManager(TMP_DIR);
  setAuthManager(manager);
  loginCommand();
  logoutCommand();
});

describe("auth manager", () => {
  test("store and retrieve API key", async () => {
    await manager.setKey("anthropic", "sk-test-key-123");
    const key = await manager.getKey("anthropic");
    expect(key).toBe("sk-test-key-123");
  });

  test("get nonexistent key returns null", async () => {
    expect(await manager.getKey("openai")).toBeNull();
  });

  test("delete a key", async () => {
    await manager.setKey("anthropic", "sk-test");
    await manager.deleteKey("anthropic");
    expect(await manager.getKey("anthropic")).toBeNull();
  });

  test("list providers with keys", async () => {
    await manager.setKey("anthropic", "sk-ant");
    await manager.setKey("openai", "sk-oai");
    const providers = await manager.listProviders();
    expect(providers).toContain("anthropic");
    expect(providers).toContain("openai");
  });

  test("isAuthenticated returns true when key exists", async () => {
    expect(await manager.isAuthenticated("anthropic")).toBe(false);
    await manager.setKey("anthropic", "sk-test");
    expect(await manager.isAuthenticated("anthropic")).toBe(true);
  });
});

describe("auth commands", () => {
  test("/login command is registered", () => {
    const cmd = getCommand("login");
    expect(cmd).toBeDefined();
    expect(cmd!.description).toContain("login");
  });

  test("/logout command is registered", () => {
    const cmd = getCommand("logout");
    expect(cmd).toBeDefined();
    expect(cmd!.description).toContain("logout");
  });

  test("/login sets key for provider", async () => {
    const cmd = getCommand("login")!;
    const result = await cmd.execute("anthropic sk-test-key");
    expect(result.type).toBe("text");
    expect(result.content).toContain("anthropic");
    expect(await manager.getKey("anthropic")).toBe("sk-test-key");
  });

  test("/logout removes key for provider", async () => {
    await manager.setKey("anthropic", "sk-test");
    const cmd = getCommand("logout")!;
    const result = await cmd.execute("anthropic");
    expect(result.type).toBe("text");
    expect(await manager.getKey("anthropic")).toBeNull();
  });
});
