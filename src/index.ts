#!/usr/bin/env bun
/**
 * Alfred CLI entry point.
 *
 *   alfred                 bare: REPL on a TTY, status screen otherwise
 *   alfred [prompt]        one-shot agent run (-p print mode; reads stdin when piped)
 *   alfred run             autonomous harness: drive feature_list.json to green
 *   alfred demo            offline proof in a sandbox — no API key needed
 *   alfred init            scaffold feature_list.json for `alfred run`
 *   alfred why [runId]     explain a run from its receipts (what blocked, and why)
 *   alfred watch [path]    follow a run's journal + ledger live (replays finished runs)
 *   alfred eval <file>     replay recorded trajectories, assert no regressions
 *   alfred status          provider · feature_list · last run, at a glance
 *   alfred ledger …        verify (exit 2 on tamper) / show (--md for PR paste)
 *   alfred completion <sh> bash/zsh completion script
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
 * ledger), ALFRED_MOCK_SCRIPTS=<path> (scripted offline provider — keyless
 * demos and deterministic smoke runs; engine/tools/gates stay real). Hooks
 * load from .alfred/hooks.json; skills from .alfred/skills/; MCP/LSP servers
 * from .alfred/{mcp,lsp}.json.
 */
import { join, relative, resolve } from "node:path";
import { Command } from "commander";
import { resolveApprover } from "./cli/approve.ts";
import { palette } from "./cli/colors.ts";
import { COMPLETION_SHELLS, type CompletionShell, completionScript } from "./cli/completion.ts";
import { runDemo } from "./cli/demo.ts";
import { runInit } from "./cli/init.ts";
import { formatLedgerTable } from "./cli/ledgerShow.ts";
import { renderAutonomousEvent } from "./cli/renderRun.ts";
import { startRepl } from "./cli/repl.ts";
import {
  buildSession,
  closeSession,
  drainRendered,
  keyPresent,
  missingFeatureListMessage,
  missingKeyMessage,
  mockActive,
  queryConfigFromSession,
  resolveProvider,
} from "./cli/session.ts";
import { gatherStatus, renderStatus } from "./cli/status.ts";
import { resolveWatchDir, standardWatchIo, watchRun } from "./cli/watch.ts";
import { gatherWhy, renderWhy } from "./cli/why.ts";
import { type ConfigOverrides, loadConfig, PERMISSION_MODES } from "./config/manager.ts";
import { loadModelOverrides } from "./config/modelOverrides.ts";
import { resolveRole } from "./config/roles.ts";
import { formatReport, runEvalSuite } from "./eval/runner.ts";
import type { EvalCase } from "./eval/types.ts";
import { Journal } from "./orchestrator/journal.ts";
import { Ledger } from "./orchestrator/ledger.ts";
import {
  DEFAULT_LEDGER_SECRET,
  findLatestLedger,
  formatVerifyOutcome,
} from "./orchestrator/ledgerLocate.ts";
import { createRuntime } from "./orchestrator/runtime.ts";
import { type AutonomousEvent, autonomousRun } from "./orchestrator/workflows/autonomousRun.ts";
import { runQuery } from "./query/engine.ts";
import { VERSION } from "./version.ts";

const c = palette(process.stderr);
const { dim, red, yellow } = c;

interface CliOptions {
  readonly model?: string;
  readonly permissionMode?: (typeof PERMISSION_MODES)[number];
  readonly maxTurns?: string;
  readonly yes?: boolean;
  readonly print?: boolean;
}

/** Numeric CLI overrides from the raw commander option bag. */
function overridesFrom(opts: CliOptions): ConfigOverrides {
  return {
    model: opts.model,
    permissionMode: opts.permissionMode,
    maxTurns: opts.maxTurns ? Number(opts.maxTurns) : undefined,
  };
}

async function runOnce(prompt: string, opts: CliOptions): Promise<number> {
  const overrides = overridesFrom(opts);
  // Fail at the front door with the exact fix, not deep inside the SDK.
  const keyErr = missingKeyMessage(loadConfig(overrides), c);
  if (keyErr !== null) {
    process.stderr.write(keyErr);
    return 1;
  }

  const session = await buildSession(overrides);
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());

  try {
    const state = await drainRendered(
      runQuery(prompt, {
        ...queryConfigFromSession(session),
        // Interactive approval on a TTY; --yes auto-approves; otherwise the
        // engine denies "ask" tools with actionable guidance.
        approve: resolveApprover(opts.yes),
        signal: controller.signal,
      }),
      c,
    );

    if (state.cost && state.cost.usd > 0) {
      process.stderr.write(dim(`[cost: $${state.cost.usd.toFixed(4)}]\n`));
    }

    process.stdout.write("\n");
    return state.status === "success" ? 0 : 1;
  } finally {
    await closeSession(session);
  }
}

interface RunCliOptions {
  readonly model?: string;
  readonly featureList?: string;
  readonly verify?: string;
  readonly verifyFast?: string;
  readonly maxFeatures?: string;
  readonly rollbackOnBlock?: boolean;
  readonly budgetUsd?: string;
  readonly bestOfN?: string;
  readonly json?: boolean;
}

/** `alfred run` — the autonomous harness as a workflow (ADR 0001 §5.3 / §7.7). */
async function runAutonomous(opts: RunCliOptions): Promise<number> {
  const cfg = loadConfig({ model: opts.model });
  const keyErr = missingKeyMessage(cfg, c);
  if (keyErr !== null) {
    process.stderr.write(keyErr);
    return 1;
  }

  const workingDir = process.cwd();
  loadModelOverrides(workingDir, (m) => process.stderr.write(yellow(`[models] ${m}\n`)));
  const featureListPath = opts.featureList ?? join(workingDir, "feature_list.json");
  if (!(await Bun.file(featureListPath).exists())) {
    process.stderr.write(missingFeatureListMessage(featureListPath, workingDir, c));
    return 1;
  }
  const verifyCmd = opts.verify ?? process.env.ALFRED_VERIFY_CMD ?? "bun test";
  const fastVerifyCmd = opts.verifyFast ?? process.env.ALFRED_VERIFY_FAST_CMD;
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(workingDir, ".alfred", "workflows", runId);
  const journal = new Journal(join(runDir, "journal.jsonl"));
  const ledgerSecret = process.env.ALFRED_LEDGER_SECRET ?? DEFAULT_LEDGER_SECRET;
  const ledger = new Ledger(join(runDir, "ledger.jsonl"), ledgerSecret);

  // Architect/editor split (ADR 0005): resolve per-role models from config.
  const roles = cfg.roles ?? {};
  const architectModel = resolveRole(roles, "architect", cfg.model).model;
  const editorModel = resolveRole(roles, "editor", cfg.model).model;

  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());

  const runtime = createRuntime(runId, {
    provider: await resolveProvider(cfg.provider),
    model: cfg.model,
    // Autonomous mode runs headless: bypass prompts, but the kill-list and
    // path jail still apply (ADR 0003). Override with care.
    permissions: { mode: "bypass", allowedTools: new Set(), deniedTools: new Set(), workingDir },
    journal,
    budget: opts.budgetUsd ? { maxUsd: Number(opts.budgetUsd) } : undefined,
    signal: controller.signal,
    onLog: (m) => process.stderr.write(dim(`  ${m}\n`)),
  });

  process.stderr.write(
    // Relative path: terminal output should be shareable without leaking the
    // operator's home directory (same instinct as ledger redaction, ADR 0003).
    dim(
      `[run ${runId}] feature_list=${relative(workingDir, featureListPath) || featureListPath} verify="${verifyCmd}"\n`,
    ),
  );

  const result = await autonomousRun({
    runtime,
    ledger,
    cwd: workingDir,
    featureListPath,
    verifyCmd,
    fastVerifyCmd,
    maxFeatures: opts.maxFeatures ? Number(opts.maxFeatures) : undefined,
    rollbackOnBlock: Boolean(opts.rollbackOnBlock),
    architectModel,
    editorModel,
    bestOfN: opts.bestOfN ? Number(opts.bestOfN) : undefined,
    onEvent: (ev: AutonomousEvent) => {
      // Machine stream on stdout behind --json; human progress on stderr by
      // default (one line per harness event — legibility without a TUI).
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(ev)}\n`);
        return;
      }
      const line = renderAutonomousEvent(ev, c);
      if (line !== null) process.stderr.write(`${line}\n`);
    },
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
    let prompt = promptParts.join(" ").trim();
    // `echo "question" | alfred -p` — print mode reads the prompt from stdin.
    if (prompt === "" && opts.print && !process.stdin.isTTY) {
      prompt = (await Bun.stdin.text()).trim();
    }
    if (prompt === "") {
      const overrides = overridesFrom(opts);
      const cfg = loadConfig(overrides);
      const canQuery = mockActive() || keyPresent(cfg.provider);
      // Bare `alfred` on a TTY opens the thin REPL; everywhere else (pipes,
      // CI, missing key) it prints the status screen with next steps.
      if (!opts.print && canQuery && process.stdin.isTTY && process.stderr.isTTY) {
        process.exit(await startRepl({ overrides, yes: opts.yes }));
      }
      const cOut = palette(process.stdout);
      const status = await gatherStatus(process.cwd(), {
        provider: cfg.provider,
        model: cfg.model,
        keyPresent: keyPresent(cfg.provider),
        mockActive: mockActive(),
      });
      process.stdout.write(`${renderStatus(status, cOut)}\n`);
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
  .option(
    "--verify-fast <cmd>",
    "fast pre-gate (e.g. affected tests / tsc); failures short-circuit the fix loop, only --verify can pass a feature",
  )
  .option("--max-features <n>", "stop after N features")
  .option("--rollback-on-block", "git-rollback the working tree when a feature is blocked")
  .option("--budget-usd <n>", "stop when estimated spend exceeds this USD budget")
  .option(
    "--best-of-n <n>",
    "run N worktree-isolated implement candidates per attempt, keep the first that passes",
  )
  .option("--json", "emit raw harness events as JSON lines on stdout (machine-readable)")
  .action(async (opts: RunCliOptions) => {
    const code = await runAutonomous(opts);
    process.exit(code);
  });

program
  .command("eval <file>")
  .description(
    "replay recorded trajectories (a module exporting EvalCase[]) and assert no regressions",
  )
  .action(async (file: string) => {
    const mod: { default?: readonly EvalCase[]; cases?: readonly EvalCase[] } = await import(
      resolve(process.cwd(), file)
    );
    const cases = mod.default ?? mod.cases ?? [];
    const report = await runEvalSuite(cases);
    process.stdout.write(formatReport(report) + "\n");
    process.exit(report.failed > 0 ? 1 : 0);
  });

const ledgerCommand = program
  .command("ledger")
  .description("inspect and verify signed run ledgers (Proof Receipts)");

ledgerCommand
  .command("verify")
  .argument("[path]", "path to a ledger.jsonl (default: the latest run under .alfred/workflows)")
  .description("recompute the HMAC hash chain + signed head anchor; exit 2 on any tamper")
  .action(async (path?: string) => {
    const target = path ?? (await findLatestLedger(process.cwd()));
    if (target === null) {
      process.stderr.write(
        red("No run ledger found under .alfred/workflows — start one with `alfred run`.\n"),
      );
      process.exit(1);
    }
    if (!(await Bun.file(target).exists())) {
      process.stderr.write(red(`No ledger at ${target}\n`));
      process.exit(1);
    }
    const secret = process.env.ALFRED_LEDGER_SECRET ?? DEFAULT_LEDGER_SECRET;
    const ledger = new Ledger(target, secret);
    const rows = (await ledger.readAll()).length;
    const outcome = await ledger.verify();
    // Display a cwd-relative path: shareable output, no home-directory leak.
    const display = relative(process.cwd(), target) || target;
    process.stdout.write(formatVerifyOutcome(display, rows, outcome) + "\n");
    // Exit-code contract: 0 = intact, 1 = no ledger / bad invocation, 2 = TAMPERED.
    process.exit(outcome.ok ? 0 : 2);
  });

ledgerCommand
  .command("show")
  .argument("[path]", "path to a ledger.jsonl (default: the latest run under .alfred/workflows)")
  .option("--md", "Markdown table — paste straight into a PR description")
  .description("render a run ledger's rows as a table, then verify the chain")
  .action(async (path: string | undefined, opts: { md?: boolean }) => {
    const target = path ?? (await findLatestLedger(process.cwd()));
    if (target === null || !(await Bun.file(target).exists())) {
      process.stderr.write(
        red("No run ledger found under .alfred/workflows — start one with `alfred run`.\n"),
      );
      process.exit(1);
    }
    const secret = process.env.ALFRED_LEDGER_SECRET ?? DEFAULT_LEDGER_SECRET;
    const ledger = new Ledger(target, secret);
    const rows = await ledger.readAll();
    const outcome = await ledger.verify();
    process.stdout.write(`${formatLedgerTable(rows, { md: Boolean(opts.md) })}\n`);
    const display = relative(process.cwd(), target) || target;
    process.stderr.write(`${formatVerifyOutcome(display, rows.length, outcome)}\n`);
    process.exit(outcome.ok ? 0 : 2);
  });

program
  .command("status")
  .description("provider, feature_list and last-run state at a glance")
  .action(async () => {
    const cfg = loadConfig({});
    const cOut = palette(process.stdout);
    const status = await gatherStatus(process.cwd(), {
      provider: cfg.provider,
      model: cfg.model,
      keyPresent: keyPresent(cfg.provider),
      mockActive: mockActive(),
    });
    process.stdout.write(`${renderStatus(status, cOut)}\n`);
  });

program
  .command("demo")
  .description(
    "30-second offline proof: scripted model, real gate, real signed ledger, tamper drill — no API key",
  )
  .action(async () => {
    process.exit(await runDemo());
  });

program
  .command("init")
  .description("scaffold feature_list.json (and a .gitignore entry) for `alfred run`")
  .option("--force", "overwrite an existing feature_list.json")
  .action(async (opts: { force?: boolean }) => {
    process.exit(await runInit(process.cwd(), opts));
  });

program
  .command("why")
  .argument("[runId]", "run id under .alfred/workflows (default: the latest run)")
  .option("--json", "emit the explanation as JSON")
  .description("explain a run from its receipts: which features blocked, and why")
  .action(async (runId: string | undefined, opts: { json?: boolean }) => {
    const data = await gatherWhy(process.cwd(), runId);
    if (data === null) {
      process.stderr.write(
        red("No run found under .alfred/workflows — start one with `alfred run`.\n"),
      );
      process.exit(1);
    }
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderWhy(data, palette(process.stdout))}\n`);
    }
    process.exit(0);
  });

program
  .command("watch")
  .argument("[path]", "run directory or ledger.jsonl (default: the latest run)")
  .description("follow a run's journal + ledger as a read-only live panel (replays finished runs)")
  .action(async (path?: string) => {
    const runDir = await resolveWatchDir(process.cwd(), path);
    if (runDir === null) {
      process.stderr.write(
        red("No run found under .alfred/workflows — start one with `alfred run`.\n"),
      );
      process.exit(1);
    }
    const io = standardWatchIo();
    process.on("SIGINT", () => {
      io.clearStatus();
      process.stderr.write("\n");
      process.exit(130);
    });
    const code = await watchRun(runDir, io, {
      palette: palette(process.stdout),
      featureListPath: resolve(process.cwd(), "feature_list.json"),
    });
    process.exit(code);
  });

program
  .command("completion")
  .argument("<shell>", `one of: ${COMPLETION_SHELLS.join(", ")}`)
  .description('print a shell completion script — e.g. eval "$(alfred completion zsh)"')
  .action((shell: string) => {
    if (!(COMPLETION_SHELLS as readonly string[]).includes(shell)) {
      process.stderr.write(
        red(`unsupported shell "${shell}" — use ${COMPLETION_SHELLS.join(" or ")}\n`),
      );
      process.exit(1);
    }
    const names = program.commands.map((cmd) => cmd.name());
    process.stdout.write(completionScript(shell as CompletionShell, names));
  });

await program.parseAsync(process.argv);
