#!/usr/bin/env bun
/**
 * Alfred CLI entry point.
 *
 *   alfred [prompt]      one-shot agent run (-p print mode)
 *   alfred run           autonomous harness: drive feature_list.json to green
 *   alfred eval <file>   replay recorded trajectories, assert no regressions
 *
 * Text goes to stdout; tool/retry/status traces go to stderr, so
 * `alfred -p "…" | cat` captures a clean answer.
 *
 * Opt-in layers: ALFRED_MEMORY=1 (memory inject/prefetch/GC, ADR 0001 §4),
 * ALFRED_REPOMAP=1 (repo map, ADR 0002), ALFRED_SANDBOX=1 (OS sandbox, ADR
 * 0001 §7.3), ALFRED_QUARANTINE=1 (dual-LLM quarantine of untrusted output,
 * ADR 0003), ALFRED_OTEL_FILE=<path> (OTel spans, ADR 0004), ALFRED_BASE_URL
 * (Anthropic-compatible endpoint, e.g. GLM), ALFRED_MODEL_{ARCHITECT,EDITOR,
 * SUBAGENT} (role routing, ADR 0005), ALFRED_LEDGER_SECRET (sign the run
 * ledger). Hooks load from .alfred/hooks.json; skills from .alfred/skills/;
 * MCP/LSP servers from .alfred/{mcp,lsp}.json.
 */
import { Command } from "commander";
import { join, resolve } from "node:path";
import { runQuery } from "./query/engine.ts";
import type { QueryEvent } from "./query/types.ts";
import { getProvider } from "./providers/index.ts";
import { getAllTools } from "./tools/index.ts";
import { buildSystemContext, buildSystemPrompt } from "./context/index.ts";
import { loadConfig, PERMISSION_MODES, type ConfigOverrides } from "./config/manager.ts";
import { resolveRole } from "./config/roles.ts";
import { LocalFileProvider } from "./memory/localFile.ts";
import { loadHooksConfig } from "./hooks/engine.ts";
import { bootstrapExtensions } from "./extensions/bootstrap.ts";
import { createRuntime } from "./orchestrator/runtime.ts";
import { Journal } from "./orchestrator/journal.ts";
import { Ledger } from "./orchestrator/ledger.ts";
import { autonomousRun, type AutonomousEvent } from "./orchestrator/workflows/autonomousRun.ts";
import { runEvalSuite, formatReport } from "./eval/runner.ts";
import type { EvalCase } from "./eval/types.ts";
import { VERSION } from "./version.ts";

const dim = (s: string) => (process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const red = (s: string) => (process.stderr.isTTY ? `\x1b[31m${s}\x1b[0m` : s);

function renderEvent(ev: QueryEvent): void {
  switch (ev.type) {
    case "text":
      process.stdout.write(ev.text);
      break;
    case "tool_use":
      process.stderr.write(dim(`\n⚙ ${ev.describe}\n`));
      break;
    case "tool_result": {
      const body = ev.output.length > 500 ? ev.output.slice(0, 500) + " …" : ev.output;
      process.stderr.write((ev.isError ? red : dim)(`  ${body.replace(/\n/g, "\n  ")}\n`));
      break;
    }
    case "retrying":
      process.stderr.write(dim(`\n↻ retry ${ev.attempt} in ${ev.delayMs}ms (${ev.reason})\n`));
      break;
    case "error":
      process.stderr.write(red(`\n✗ ${ev.message}\n`));
      break;
    case "done":
      process.stderr.write(dim(`\n[${ev.status}]\n`));
      break;
  }
}

interface CliOptions {
  readonly model?: string;
  readonly permissionMode?: (typeof PERMISSION_MODES)[number];
  readonly maxTurns?: string;
  readonly yes?: boolean;
  readonly print?: boolean;
}

async function runOnce(prompt: string, opts: CliOptions): Promise<number> {
  const overrides: ConfigOverrides = {
    model: opts.model,
    permissionMode: opts.permissionMode,
    maxTurns: opts.maxTurns ? Number(opts.maxTurns) : undefined,
  };
  const cfg = loadConfig(overrides);

  if (cfg.provider === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
    process.stderr.write(red("No ANTHROPIC_API_KEY set — export it before running a real query.\n"));
  }
  if (cfg.provider === "openai" && !process.env.OPENAI_API_KEY) {
    process.stderr.write(red("No OPENAI_API_KEY set — export it before running a real query.\n"));
  }

  const workingDir = process.cwd();
  const memoryEnabled = Boolean(process.env.ALFRED_MEMORY);
  const memoryRoot = join(workingDir, ".alfred", "memory");
  // One provider instance drives prefetch (in the engine) and extract (on end).
  const memory = memoryEnabled ? new LocalFileProvider(memoryRoot) : undefined;

  const [sysCtx, hooks, ext] = await Promise.all([
    buildSystemContext(workingDir, {
      repoMap: process.env.ALFRED_REPOMAP ? {} : false,
      memoryRoot: memoryEnabled ? memoryRoot : false,
    }),
    loadHooksConfig(join(workingDir, ".alfred", "hooks.json")),
    bootstrapExtensions(workingDir),
  ]);
  const systemPrompt = buildSystemPrompt(sysCtx);

  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());

  try {
    const state = await drain(
      runQuery(prompt, {
        provider: getProvider(cfg.provider),
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        systemPrompt,
        maxTokens: cfg.maxTokens,
        maxTurns: cfg.maxTurns,
        maxContextTokens: cfg.maxContextTokens,
        roles: cfg.roles,
        hooks,
        memory,
        // MCP/LSP tools (if any servers are configured) on top of the built-ins.
        tools: ext.tools.length > 0 ? [...getAllTools(), ...ext.tools] : undefined,
        permissions: {
          mode: cfg.permissionMode,
          allowedTools: new Set(),
          deniedTools: new Set(),
          workingDir,
        },
        approve: opts.yes ? async () => true : undefined,
        signal: controller.signal,
      }),
    );

    // Memory extract: staleness / contradiction GC on session end (ADR 0001 §4).
    if (memory) {
      try {
        await memory.extract();
        memory.close();
      } catch {
        // best-effort; never fail the run on a GC error
      }
    }

    if (state.cost && state.cost.usd > 0) {
      process.stderr.write(dim(`[cost: $${state.cost.usd.toFixed(4)}]\n`));
    }

    process.stdout.write("\n");
    return state.status === "success" ? 0 : 1;
  } finally {
    await ext.close();
  }
}

async function drain(gen: ReturnType<typeof runQuery>) {
  let result = await gen.next();
  while (!result.done) {
    renderEvent(result.value);
    result = await gen.next();
  }
  return result.value;
}

interface RunCliOptions {
  readonly model?: string;
  readonly featureList?: string;
  readonly verify?: string;
  readonly maxFeatures?: string;
  readonly rollbackOnBlock?: boolean;
  readonly budgetUsd?: string;
  readonly bestOfN?: string;
}

/** `alfred run` — the autonomous harness as a workflow (ADR 0001 §5.3 / §7.7). */
async function runAutonomous(opts: RunCliOptions): Promise<number> {
  const cfg = loadConfig({ model: opts.model });
  if (cfg.provider === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
    process.stderr.write(red("No ANTHROPIC_API_KEY set — export it before an autonomous run.\n"));
  }

  const workingDir = process.cwd();
  const featureListPath = opts.featureList ?? join(workingDir, "feature_list.json");
  const verifyCmd = opts.verify ?? process.env.ALFRED_VERIFY_CMD ?? "bun test";
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(workingDir, ".alfred", "workflows", runId);
  const journal = new Journal(join(runDir, "journal.jsonl"));
  const ledgerSecret = process.env.ALFRED_LEDGER_SECRET ?? "alfred-dev-insecure-secret-change-me";
  const ledger = new Ledger(join(runDir, "ledger.jsonl"), ledgerSecret);

  // Architect/editor split (ADR 0005): resolve per-role models from config.
  const roles = cfg.roles ?? {};
  const architectModel = resolveRole(roles, "architect", cfg.model).model;
  const editorModel = resolveRole(roles, "editor", cfg.model).model;

  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());

  const runtime = createRuntime(runId, {
    provider: getProvider(cfg.provider),
    model: cfg.model,
    // Autonomous mode runs headless: bypass prompts, but the kill-list and
    // path jail still apply (ADR 0003). Override with care.
    permissions: { mode: "bypass", allowedTools: new Set(), deniedTools: new Set(), workingDir },
    journal,
    budget: opts.budgetUsd ? { maxUsd: Number(opts.budgetUsd) } : undefined,
    signal: controller.signal,
    onLog: (m) => process.stderr.write(dim(`  ${m}\n`)),
  });

  process.stderr.write(dim(`[run ${runId}] feature_list=${featureListPath} verify="${verifyCmd}"\n`));

  const result = await autonomousRun({
    runtime,
    ledger,
    cwd: workingDir,
    featureListPath,
    verifyCmd,
    maxFeatures: opts.maxFeatures ? Number(opts.maxFeatures) : undefined,
    rollbackOnBlock: Boolean(opts.rollbackOnBlock),
    architectModel,
    editorModel,
    bestOfN: opts.bestOfN ? Number(opts.bestOfN) : undefined,
    onEvent: (ev: AutonomousEvent) => process.stdout.write(JSON.stringify(ev) + "\n"),
  });

  await journal.close();
  process.stderr.write(
    dim(
      `\n[run ${runId}] passing=${result.passing} blocked=${result.blocked} ` +
        `stopped=${result.stopped} ledger=${result.ledgerOk ? "ok" : "TAMPERED"}\n`,
    ),
  );
  return result.stopped === "all_resolved" && result.blocked === 0 ? 0 : 1;
}

const program = new Command();
program
  .name("alfred")
  .description("Alfred — a verifiable autonomous coding agent")
  .version(VERSION)
  .argument("[prompt...]", "task for Alfred to perform")
  .option("-m, --model <model>", "model to use")
  .option("-p, --print", "print mode (non-interactive)")
  .option("--permission-mode <mode>", `one of: ${PERMISSION_MODES.join(", ")}`)
  .option("--max-turns <n>", "maximum agent turns")
  .option("--yes", "auto-approve tool calls that would otherwise ask")
  .action(async (promptParts: string[], opts: CliOptions) => {
    const prompt = promptParts.join(" ").trim();
    if (!prompt) {
      program.help();
      return;
    }
    const code = await runOnce(prompt, opts);
    process.exit(code);
  });

program
  .command("run")
  .description("autonomously drive feature_list.json to green under a verify gate")
  .option("-m, --model <model>", "model to use")
  .option("--feature-list <path>", "path to feature_list.json (default: ./feature_list.json)")
  .option("--verify <cmd>", "verify command (default: $ALFRED_VERIFY_CMD or 'bun test')")
  .option("--max-features <n>", "stop after N features")
  .option("--rollback-on-block", "git-rollback the working tree when a feature is blocked")
  .option("--budget-usd <n>", "stop when estimated spend exceeds this USD budget")
  .option("--best-of-n <n>", "run N worktree-isolated implement candidates per attempt, keep the first that passes")
  .action(async (opts: RunCliOptions) => {
    const code = await runAutonomous(opts);
    process.exit(code);
  });

program
  .command("eval <file>")
  .description("replay recorded trajectories (a module exporting EvalCase[]) and assert no regressions")
  .action(async (file: string) => {
    const mod: { default?: readonly EvalCase[]; cases?: readonly EvalCase[] } = await import(
      resolve(process.cwd(), file)
    );
    const cases = mod.default ?? mod.cases ?? [];
    const report = await runEvalSuite(cases);
    process.stdout.write(formatReport(report) + "\n");
    process.exit(report.failed > 0 ? 1 : 0);
  });

await program.parseAsync(process.argv);
