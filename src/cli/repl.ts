/**
 * The thin REPL — the porch the TUI living room grew out of (0.8).
 *
 * Since 0.8 the bare `alfred` invocation opens the interactive TUI
 * (src/cli/tui/); this readline surface remains as the deliberate fallback
 * for `ALFRED_TUI=0` and for terminals where the repaint protocol is
 * unwelcome: multi-turn conversation (engine-native via initialMessages),
 * interactive tool approval, and a handful of slash commands.
 */
import * as readline from "node:readline";
import type { ConfigOverrides } from "../config/manager.ts";
import { fireLifecycleHooks, firePromptHooks } from "../hooks/lifecycle.ts";
import type { Message } from "../providers/types.ts";
import { runQuery } from "../query/engine.ts";
import { createApprover } from "./approve.ts";
import { palette } from "./colors.ts";
import {
  buildSession,
  closeSession,
  drainRendered,
  hookContext,
  keyPresent,
  mockActive,
  queryConfigFromSession,
} from "./session.ts";
import { gatherStatus, renderStatus } from "./status.ts";

const HELP = [
  "/help    this list",
  "/status  provider · feature_list · last run",
  "/clear   drop the conversation history",
  "/cost    session spend so far",
  "/exit    leave (also /quit, Ctrl-D)",
].join("\n");

export interface ReplOptions {
  readonly overrides: ConfigOverrides;
  readonly yes?: boolean | undefined;
}

/** Run the interactive session until /exit or EOF. Returns the exit code. */
export async function startRepl(opts: ReplOptions): Promise<number> {
  const c = palette(process.stderr);
  const say = (s: string) => process.stderr.write(`${s}\n`);

  const session = await buildSession(opts.overrides);
  const hookCtx = hookContext(session);
  await fireLifecycleHooks(session.hooks, "SessionStart", hookCtx, "repl");
  const statusEnv = {
    provider: session.cfg.provider,
    model: session.cfg.model,
    keyPresent: keyPresent(session.cfg.provider),
    mockActive: mockActive(),
  };
  say(renderStatus(await gatherStatus(session.workingDir, statusEnv), c));
  say("");
  say(c.dim("interactive session — /help for commands. Tool calls ask for approval (a = always)."));
  say("");

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  rl.setPrompt(c.bold("alfred> "));
  const question = (q: string) => new Promise<string>((res) => rl.question(q, res));
  const approver = opts.yes ? async () => true : createApprover(question);

  let history: readonly Message[] = [];
  let totalUsd = 0;
  let current: AbortController | null = null;

  rl.on("SIGINT", () => {
    if (current !== null) {
      current.abort();
      say("");
    } else {
      say(c.dim("\n(/exit to quit)"));
      rl.prompt();
    }
  });

  rl.prompt();
  for await (const raw of rl) {
    const input = raw.trim();
    if (input === "") {
      rl.prompt();
      continue;
    }
    if (input === "/exit" || input === "/quit" || input === "/q") break;
    if (input === "/help") {
      say(HELP);
      rl.prompt();
      continue;
    }
    if (input === "/clear") {
      history = [];
      say(c.dim("history cleared"));
      rl.prompt();
      continue;
    }
    if (input === "/cost") {
      say(`session cost: $${totalUsd.toFixed(4)}`);
      rl.prompt();
      continue;
    }
    if (input === "/status") {
      say(renderStatus(await gatherStatus(session.workingDir, statusEnv), c));
      rl.prompt();
      continue;
    }
    if (input.startsWith("/")) {
      say(c.yellow(`unknown command ${input} — /help`));
      rl.prompt();
      continue;
    }

    const promptGate = await firePromptHooks(session.hooks, input, hookCtx);
    if (promptGate.block) {
      say(c.red(`prompt blocked by hook: ${promptGate.reason}`));
      rl.prompt();
      continue;
    }

    current = new AbortController();
    try {
      const state = await drainRendered(
        runQuery(input, {
          ...queryConfigFromSession(session),
          approve: approver,
          signal: current.signal,
          initialMessages: history,
        }),
        c,
      );
      history = state.messages;
      if (state.cost) totalUsd += state.cost.usd;
      process.stdout.write("\n");
      await fireLifecycleHooks(session.hooks, "Stop", hookCtx);
    } catch (err) {
      say(c.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
    } finally {
      current = null;
    }
    rl.prompt();
  }

  rl.close();
  await fireLifecycleHooks(session.hooks, "SessionEnd", hookCtx, "exit");
  await closeSession(session);
  say(c.dim(`session cost: $${totalUsd.toFixed(4)}`));
  return 0;
}
