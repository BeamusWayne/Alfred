import { registerCommand } from "./types.js";

registerCommand({
  name: "compact",
  description: "Compress conversation context to save tokens",
  execute: async () => {
    return { type: "text", content: "Context compaction not yet implemented." };
  },
});
