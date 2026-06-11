/**
 * `alfred status` / bare-run status screen — the CLI's anchor view.
 *
 * Answers, in one glance: can I launch (provider/key), what would launch
 * (feature_list state), and what happened last (latest run + receipt). Every
 * fact comes with the next command to run — the CLI teaches itself.
 *
 * `gatherStatus` does the IO; `renderStatus` is pure (unit-tested).
 */
import { basename, dirname, join, relative } from "node:path";
import { counts, loadFeatureList } from "../harness/featureList.ts";
import { Ledger } from "../orchestrator/ledger.ts";
import { DEFAULT_LEDGER_SECRET, findLatestLedger } from "../orchestrator/ledgerLocate.ts";
import { VERSION } from "../version.ts";
import type { Palette } from "./colors.ts";

export interface StatusInfo {
  readonly version: string;
  readonly provider: string;
  readonly model: string;
  readonly keyPresent: boolean;
  readonly mockActive: boolean;
  readonly featureList: {
    readonly path: string;
    readonly pending: number;
    readonly inProgress: number;
    readonly passing: number;
    readonly blocked: number;
  } | null;
  readonly lastRun: {
    readonly runId: string;
    readonly ledgerPath: string;
    readonly passing: number;
    readonly blocked: number;
    readonly stopped: string;
  } | null;
}

export interface StatusEnv {
  readonly provider: string;
  readonly model: string;
  readonly keyPresent: boolean;
  readonly mockActive: boolean;
}

/** Collect the status facts for `cwd`. Never throws — absent pieces are null. */
export async function gatherStatus(cwd: string, env: StatusEnv): Promise<StatusInfo> {
  const featureListPath = join(cwd, "feature_list.json");
  let featureList: StatusInfo["featureList"] = null;
  try {
    const list = await loadFeatureList(featureListPath);
    const c = counts(list);
    featureList = {
      path: relative(cwd, featureListPath) || featureListPath,
      pending: c.pending,
      inProgress: c.in_progress,
      passing: c.passing,
      blocked: c.blocked,
    };
  } catch {
    // missing or invalid — rendered as "none"
  }

  let lastRun: StatusInfo["lastRun"] = null;
  try {
    const ledgerPath = await findLatestLedger(cwd);
    if (ledgerPath !== null) {
      const rows = await new Ledger(ledgerPath, DEFAULT_LEDGER_SECRET).readAll();
      const end = [...rows].reverse().find((r) => r.kind === "run_end");
      const data = (end?.data ?? {}) as Record<string, unknown>;
      lastRun = {
        runId: basename(dirname(ledgerPath)),
        ledgerPath: relative(cwd, ledgerPath) || ledgerPath,
        passing: typeof data.passing === "number" ? data.passing : 0,
        blocked: typeof data.blocked === "number" ? data.blocked : 0,
        stopped: typeof data.stopped === "string" ? data.stopped : "unknown",
      };
    }
  } catch {
    // unreadable ledger — rendered as "none"
  }

  return {
    version: VERSION,
    provider: env.provider,
    model: env.model,
    keyPresent: env.keyPresent,
    mockActive: env.mockActive,
    featureList,
    lastRun,
  };
}

/** Contextual next steps — at most three, most urgent first. */
export function suggestions(s: StatusInfo): readonly string[] {
  const out: string[] = [];
  if (!s.keyPresent && !s.mockActive) {
    out.push("alfred demo — watch a verified run, no API key needed");
    out.push(
      `export ${s.provider === "openai" ? "OPENAI" : "ANTHROPIC"}_API_KEY=… — enable real runs`,
    );
  }
  if (s.featureList === null) {
    out.push("alfred init — scaffold a feature_list.json for `alfred run`");
  } else if (s.featureList.pending > 0 && (s.keyPresent || s.mockActive)) {
    out.push('alfred run --verify "bun test" — drive the list to green under the gate');
  }
  if (s.lastRun !== null) {
    if (s.lastRun.blocked > 0) out.push("alfred why — explain what blocked the last run");
    else out.push("alfred ledger verify — recheck the last run's signed receipt");
  }
  return out.slice(0, 3);
}

/** Render the status screen (pure; color via the injected palette). */
export function renderStatus(s: StatusInfo, c: Palette): string {
  const key = s.mockActive
    ? c.yellow("scripted (ALFRED_MOCK_SCRIPTS — no API calls)")
    : s.keyPresent
      ? c.green("key ✓")
      : c.red("key ✗");
  const fl = s.featureList
    ? `${s.featureList.path} — ` +
      [
        s.featureList.pending > 0 ? `${s.featureList.pending} pending` : "",
        s.featureList.inProgress > 0 ? `${s.featureList.inProgress} in_progress` : "",
        s.featureList.passing > 0 ? c.green(`${s.featureList.passing} passing`) : "",
        s.featureList.blocked > 0 ? c.red(`${s.featureList.blocked} blocked`) : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : c.dim("none — `alfred init`");
  const run = s.lastRun
    ? `${s.lastRun.runId} — ${s.lastRun.passing} passing · ${s.lastRun.blocked} blocked (${s.lastRun.stopped})`
    : c.dim("none yet");

  const lines = [
    `${c.bold(`alfred v${s.version}`)} — a verifiable autonomous coding agent`,
    "",
    `  provider      ${s.provider} (${key})`,
    `  model         ${s.model}`,
    `  feature_list  ${fl}`,
    `  last run      ${run}`,
  ];
  const next = suggestions(s);
  if (next.length > 0) {
    lines.push("", c.dim("next:"));
    for (const n of next) lines.push(`  ${n}`);
  }
  return lines.join("\n");
}
