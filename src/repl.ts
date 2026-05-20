import chalk from "chalk";
import React from "react";
import { render } from "ink";
import { Repl, type StreamChunk } from "./components/Repl.js";
import { query } from "./query/engine.js";
import type { QueryConfig } from "./query/types.js";
import type { ToolUseContext } from "./tools/types.js";
import { createPermissionContext } from "./permissions/types.js";
import { registerTool } from "./tools/index.js";
import { parseCommand, getCommand } from "./commands/types.js";

// --- Register all tools ---
import { bashTool } from "./tools/bash.js";
import { fileReadTool } from "./tools/fileRead.js";
import { fileWriteTool } from "./tools/fileWrite.js";
import { fileEditTool } from "./tools/fileEdit.js";
import { globTool } from "./tools/glob.js";
import { grepTool } from "./tools/grep.js";
import { webFetchTool } from "./tools/webFetch.js";
import { webSearchTool } from "./tools/webSearch.js";
import { taskCreateTool } from "./tools/taskCreate.js";
import { taskUpdateTool } from "./tools/taskUpdate.js";
import { taskListTool } from "./tools/taskList.js";
import { skillTool } from "./tools/skillTool.js";
import { memoryCreateTool, memorySearchTool, memoryDeleteTool } from "./tools/memoryTool.js";

// --- Register all commands ---
import "./commands/index.js";

// Register tools into the registry
for (const tool of [
  bashTool, fileReadTool, fileWriteTool, fileEditTool,
  globTool, grepTool, webFetchTool, webSearchTool,
  taskCreateTool, taskUpdateTool, taskListTool,
  skillTool, memoryCreateTool, memorySearchTool, memoryDeleteTool,
]) {
  registerTool(tool);
}

interface ReplOptions {
  prompt?: string;
  model?: string;
  print?: boolean;
  verbose?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
}

function resolveConfig(options: ReplOptions): QueryConfig {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  const defaultModel = process.env.ANTHROPIC_MODEL ?? "glm-5.1";

  return {
    provider: "anthropic",
    model: options.model ?? defaultModel,
    maxTurns: 50,
    apiKey,
    baseUrl,
  };
}

function buildToolContext(options: ReplOptions): ToolUseContext {
  return {
    abortController: new AbortController(),
    workingDir: process.cwd(),
    readFileState: new Map(),
    permissionContext: createPermissionContext({
      mode: "bypass",
      allowedTools: options.allowedTools ?? [],
      deniedTools: options.disallowedTools ?? [],
      rules: [],
    }, process.cwd()),
  };
}

export async function runRepl(options: ReplOptions): Promise<void> {
  const config = resolveConfig(options);
  const toolContext = buildToolContext(options);

  if (!config.apiKey) {
    console.log(chalk.yellow("Warning: No API key found. Set ANTHROPIC_API_KEY in .env"));
  }

  // Print mode: single prompt, output to stdout, exit
  if (options.print && options.prompt) {
    const result = await runQueryText(options.prompt, config, toolContext);
    process.stdout.write(result + "\n");
    return;
  }

  // Prompt mode: single prompt, show in REPL-like output, exit
  if (options.prompt) {
    console.log(chalk.cyan("Alfred") + chalk.dim(` v0.1.0 — ${config.model}`));
    const result = await runQueryText(options.prompt, config, toolContext);
    console.log(result);
    return;
  }

  // Interactive TUI
  const { waitUntilExit } = render(
    React.createElement(Repl, {
      onSubmit: (input: string, onChunk: (chunk: StreamChunk) => void) =>
        handleInputStreaming(input, config, toolContext, onChunk),
      modelName: config.model,
    }),
  );

  await waitUntilExit();
}

async function handleInputStreaming(
  input: string,
  config: QueryConfig,
  toolContext: ToolUseContext,
  onChunk: (chunk: StreamChunk) => void,
): Promise<void> {
  const parsed = parseCommand(input);
  if (parsed) {
    const cmd = getCommand(parsed.name);
    if (cmd) {
      const result = await cmd.execute(parsed.args);
      if (result.type === "text") {
        onChunk({ type: "text", text: result.content });
      } else if (result.type === "error") {
        onChunk({ type: "error", error: result.message });
      } else if (result.type === "model") {
        config.model = result.model;
        onChunk({ type: "text", text: `Model changed to ${result.model}` });
      }
      onChunk({ type: "done" });
      return;
    }
    onChunk({ type: "error", error: `Unknown command: /${parsed.name}` });
    onChunk({ type: "done" });
    return;
  }

  await runQueryStreaming(input, config, toolContext, onChunk);
}

async function runQueryStreaming(
  userMessage: string,
  config: QueryConfig,
  toolContext: ToolUseContext,
  onChunk: (chunk: StreamChunk) => void,
): Promise<void> {
  try {
    for await (const event of query(userMessage, config, toolContext)) {
      if (event.type === "text" && event.text) {
        onChunk({ type: "text", text: event.text });
      } else if (event.type === "tool_use" && event.toolName) {
        onChunk({ type: "tool_start", toolName: event.toolName });
      } else if (event.type === "tool_result" && event.toolName) {
        onChunk({
          type: "tool_end",
          toolName: event.toolName,
          toolOutput: event.toolOutput?.slice(0, 200),
        });
      } else if (event.type === "error" && event.error) {
        onChunk({ type: "error", error: event.error });
      } else if (event.type === "done") {
        onChunk({ type: "done" });
      }
    }
  } catch (err) {
    onChunk({ type: "error", error: err instanceof Error ? err.message : String(err) });
  }
}

async function runQueryText(
  userMessage: string,
  config: QueryConfig,
  toolContext: ToolUseContext,
): Promise<string> {
  const parts: string[] = [];

  try {
    for await (const event of query(userMessage, config, toolContext)) {
      if (event.type === "text" && event.text) {
        parts.push(event.text);
      } else if (event.type === "tool_use") {
        parts.push(chalk.dim(`\n[tool: ${event.toolName}]`));
      } else if (event.type === "error") {
        parts.push(chalk.red(`\nError: ${event.error}`));
      }
    }
  } catch (err) {
    parts.push(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
  }

  return parts.join("");
}
