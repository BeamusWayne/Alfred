import { registerCommand } from "./types.js";

registerCommand({
  name: "config",
  description: "View or edit configuration",
  execute: async (args) => {
    if (!args.trim()) {
      return { type: "text", content: "Configuration management not yet implemented.\nUsage: /config <key> [value]" };
    }
    return { type: "text", content: `Config: ${args}` };
  },
});
