import { registerCommand, getAllCommands } from "./types.js";

registerCommand({
  name: "help",
  description: "Show available commands",
  aliases: ["?"],
  execute: async () => {
    const cmds = getAllCommands();
    const lines = cmds.map((c) => {
      const alias = c.aliases ? ` (${c.aliases.join(", ")})` : "";
      return `  /${c.name}${alias}  — ${c.description}`;
    });
    return { type: "text", content: `Available commands:\n${lines.join("\n")}` };
  },
});
