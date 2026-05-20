import { registerCommand } from "./types.js";

registerCommand({
  name: "cost",
  description: "Show token usage and cost for this session",
  execute: async () => {
    return { type: "text", content: "Cost tracking not yet connected. Coming soon." };
  },
});
