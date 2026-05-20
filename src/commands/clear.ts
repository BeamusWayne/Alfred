import { registerCommand } from "./types.js";

registerCommand({
  name: "clear",
  description: "Clear conversation history",
  execute: async () => ({ type: "clear" }),
});
