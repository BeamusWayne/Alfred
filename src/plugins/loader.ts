import { readFile } from "fs/promises";
import { join } from "path";
import { registerPlugin, type Plugin, type PluginCommand } from "./store.js";
import { registerCommand } from "../commands/types.js";

interface Manifest {
  name?: string;
  version?: string;
  description?: string;
  commands?: PluginCommand[];
  tools?: PluginCommand[];
}

interface LoadOptions {
  registerCommands?: boolean;
}

function validateManifest(raw: unknown): Manifest | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.name !== "string" || !m.name) return null;
  if (typeof m.version !== "string" || !m.version) return null;
  if (typeof m.description !== "string" || !m.description) return null;
  return {
    name: m.name,
    version: m.version,
    description: m.description,
    commands: Array.isArray(m.commands) ? m.commands : [],
    tools: Array.isArray(m.tools) ? m.tools : [],
  };
}

export async function loadPluginFromDir(dir: string, options?: LoadOptions): Promise<Plugin | null> {
  let raw: string;
  try {
    raw = await readFile(join(dir, "manifest.json"), "utf-8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const manifest = validateManifest(parsed);
  if (!manifest) return null;

  const plugin: Plugin = {
    name: manifest.name!,
    version: manifest.version!,
    description: manifest.description!,
    commands: manifest.commands ?? [],
    tools: manifest.tools ?? [],
    enabled: true,
  };

  registerPlugin(plugin);

  if (options?.registerCommands) {
    for (const cmd of plugin.commands) {
      const prompt = cmd.prompt;
      registerCommand({
        name: cmd.name,
        description: cmd.description,
        async execute(args: string) {
          return { type: "text", content: prompt.replace(/\{\{args\}\}/g, args) };
        },
      });
    }
  }

  return plugin;
}
