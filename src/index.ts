#!/Users/katya/.bun/bin/bun
import { Command } from "@commander-js/extra-typings";
import { VERSION } from "./version.js";

const program = new Command()
  .name("alfred")
  .description("AI-powered CLI coding assistant")
  .version(VERSION)
  .argument("[prompt]", "Initial prompt to send to the assistant")
  .option("-m, --model <model>", "Model to use")
  .option("-p, --print", "Run in non-interactive (print) mode")
  .option("--allowedTools <tools...>", "Tools to allow without confirmation")
  .option("--disallowedTools <tools...>", "Tools to deny")
  .option("--verbose", "Enable verbose logging")
  .action(async (prompt, options) => {
    const { runRepl } = await import("./repl.js");
    await runRepl({ prompt, ...options });
  });

program.parse();
