import { registerCommand } from "./types.js";
import { listProviders } from "../providers/index.js";

registerCommand({
  name: "model",
  description: "View or switch the active model",
  execute: async (args) => {
    if (!args.trim()) {
      return {
        type: "text",
        content: `Providers: ${listProviders().join(", ")}\nUsage: /model <provider>/<model>\nExample: /model anthropic/claude-sonnet-4-6`,
      };
    }
    return { type: "model", model: args.trim() };
  },
});
