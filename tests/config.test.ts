import { describe, test, expect, beforeEach } from "bun:test";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { ConfigManager, configSchema, type AlfredConfig } from "../src/config/manager.js";

const TMP_DIR = "/tmp/alfred-config-test";

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

describe("config manager", () => {
  test("load config from file", async () => {
    await writeFile(
      join(TMP_DIR, "settings.json"),
      JSON.stringify({ model: "claude-sonnet-4-6", maxTokens: 8192 }),
    );
    const manager = new ConfigManager(TMP_DIR);
    const config = await manager.load();
    expect(config.model).toBe("claude-sonnet-4-6");
    expect(config.maxTokens).toBe(8192);
  });

  test("return defaults when no config file", async () => {
    const manager = new ConfigManager(TMP_DIR);
    const config = await manager.load();
    expect(config.model).toBe("claude-sonnet-4-6");
    expect(config.maxTokens).toBe(4096);
  });

  test("return defaults for invalid JSON", async () => {
    await writeFile(join(TMP_DIR, "settings.json"), "not json");
    const manager = new ConfigManager(TMP_DIR);
    const config = await manager.load();
    expect(config.model).toBe("claude-sonnet-4-6");
  });

  test("save config to file", async () => {
    const manager = new ConfigManager(TMP_DIR);
    await manager.save({ model: "claude-opus-4-7", maxTokens: 16384 });
    const config = await manager.load();
    expect(config.model).toBe("claude-opus-4-7");
    expect(config.maxTokens).toBe(16384);
  });

  test("get and set individual values", async () => {
    const manager = new ConfigManager(TMP_DIR);
    await manager.load();
    await manager.set("model", "claude-haiku-4-5");
    expect(await manager.get("model")).toBe("claude-haiku-4-5");
  });

  test("validate config with Zod schema", () => {
    const valid = configSchema.safeParse({ model: "claude-sonnet-4-6", maxTokens: 8192 });
    expect(valid.success).toBe(true);
  });

  test("reject invalid model", () => {
    const result = configSchema.safeParse({ model: 123, maxTokens: 8192 });
    expect(result.success).toBe(false);
  });

  test("reject negative maxTokens", () => {
    const result = configSchema.safeParse({ model: "claude-sonnet-4-6", maxTokens: -1 });
    expect(result.success).toBe(false);
  });
});
