import { describe, test, expect, beforeEach } from "bun:test";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { clearPlugins, registerPlugin, getPlugin, listPlugins, type Plugin } from "../src/plugins/store.js";
import { loadPluginFromDir } from "../src/plugins/loader.js";
import { clearCommands, getCommand } from "../src/commands/types.js";

const TMP_DIR = "/tmp/alfred-plugins-test";

beforeEach(async () => {
  clearPlugins();
  clearCommands();
  await rm(TMP_DIR, { recursive: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

describe("plugin store", () => {
  test("register and retrieve a plugin", () => {
    const plugin: Plugin = {
      name: "my-plugin",
      version: "1.0.0",
      description: "A test plugin",
      commands: [],
      tools: [],
    };
    registerPlugin(plugin);
    expect(getPlugin("my-plugin")).toEqual(plugin);
  });

  test("list all plugins", () => {
    registerPlugin({ name: "a", version: "1.0.0", description: "A", commands: [], tools: [] });
    registerPlugin({ name: "b", version: "2.0.0", description: "B", commands: [], tools: [] });
    expect(listPlugins()).toHaveLength(2);
  });

  test("get nonexistent plugin returns undefined", () => {
    expect(getPlugin("nope")).toBeUndefined();
  });

  test("clear removes all plugins", () => {
    registerPlugin({ name: "x", version: "0.1.0", description: "X", commands: [], tools: [] });
    clearPlugins();
    expect(listPlugins()).toHaveLength(0);
  });
});

describe("plugin loading", () => {
  test("load plugin from manifest.json", async () => {
    const pluginDir = join(TMP_DIR, "demo-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "manifest.json"),
      JSON.stringify({
        name: "demo-plugin",
        version: "1.0.0",
        description: "A demo plugin",
      }),
    );

    const plugin = await loadPluginFromDir(pluginDir);
    expect(plugin).not.toBeNull();
    expect(plugin!.name).toBe("demo-plugin");
    expect(plugin!.version).toBe("1.0.0");
  });

  test("return null for missing manifest", async () => {
    const pluginDir = join(TMP_DIR, "no-manifest");
    await mkdir(pluginDir, { recursive: true });
    const plugin = await loadPluginFromDir(pluginDir);
    expect(plugin).toBeNull();
  });

  test("return null for invalid manifest", async () => {
    const pluginDir = join(TMP_DIR, "bad-manifest");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "manifest.json"), "not json");
    const plugin = await loadPluginFromDir(pluginDir);
    expect(plugin).toBeNull();
  });

  test("return null for manifest missing required fields", async () => {
    const pluginDir = join(TMP_DIR, "partial-manifest");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "manifest.json"), JSON.stringify({ name: "x" }));
    const plugin = await loadPluginFromDir(pluginDir);
    expect(plugin).toBeNull();
  });

  test("load plugin with commands", async () => {
    const pluginDir = join(TMP_DIR, "cmd-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "manifest.json"),
      JSON.stringify({
        name: "cmd-plugin",
        version: "1.0.0",
        description: "Plugin with commands",
        commands: [
          { name: "hello", description: "Say hello", prompt: "Say hello to {{args}}" },
        ],
      }),
    );

    const plugin = await loadPluginFromDir(pluginDir, { registerCommands: true });
    expect(plugin!.commands).toHaveLength(1);

    const cmd = getCommand("hello");
    expect(cmd).toBeDefined();
    const result = await cmd!.execute("World");
    expect(result.type).toBe("text");
    expect(result.content).toContain("Say hello to World");
  });

  test("nonexistent directory returns null", async () => {
    const plugin = await loadPluginFromDir("/tmp/no-such-plugin-dir");
    expect(plugin).toBeNull();
  });
});

describe("plugin lifecycle", () => {
  test("enable and disable plugin", () => {
    const plugin: Plugin = {
      name: "toggle",
      version: "1.0.0",
      description: "Toggle me",
      commands: [],
      tools: [],
      enabled: true,
    };
    registerPlugin(plugin);
    expect(getPlugin("toggle")!.enabled).toBe(true);

    // Disable
    const disabled = { ...plugin, enabled: false };
    registerPlugin(disabled);
    expect(getPlugin("toggle")!.enabled).toBe(false);
  });
});
