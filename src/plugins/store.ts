export interface PluginCommand {
  name: string;
  description: string;
  prompt: string;
}

export interface Plugin {
  name: string;
  version: string;
  description: string;
  commands: PluginCommand[];
  tools: PluginCommand[];
  enabled?: boolean;
}

const plugins = new Map<string, Plugin>();

export function registerPlugin(plugin: Plugin): void {
  plugins.set(plugin.name, plugin);
}

export function getPlugin(name: string): Plugin | undefined {
  return plugins.get(name);
}

export function listPlugins(): Plugin[] {
  return [...plugins.values()];
}

export function clearPlugins(): void {
  plugins.clear();
}
