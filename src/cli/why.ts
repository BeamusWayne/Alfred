/**
 * `alfred why` — explain the last run from its own evidence.
 *
 * Failure triage is the most real "interactive" need an autonomous agent has,
 * and its correct form is an audit command, not a chat window: read the
 * signed ledger (what the gates decided) and the journal (what the agents
 * said), then answer "which feature blocked, and why" with the receipts.
 *
 * `gatherWhy` does the IO; `renderWhy` is pure (unit-tested).
 */
import { dirname, join, relative } from "node:path";
import { Ledger } from "../orchestrator/ledger.ts";
import { DEFAULT_LEDGER_SECRET, findLatestLedger } from "../orchestrator/ledgerLocate.ts";
import type { Palette } from "./colors.ts";

export interface WhyFeature {
  readonly id: string;
  readonly status: "passing" | "blocked";
  readonly verifyExit: number | null;
  readonly rubric: number | null;
  readonly reason: string | null;
  readonly rubricReasoning: string | null;
}

export interface WhyData {
  readonly runId: string;
  readonly ledgerPath: string;
  readonly journalPath: string | null;
  readonly features: readonly WhyFeature[];
  readonly runEnd: {
    readonly passing: number;
    readonly blocked: number;
    readonly stopped: string;
  } | null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

/** Parse journal lines into a featureId → rubric reasoning map (last wins). */
export function rubricReasonsFromJournal(journalText: string): ReadonlyMap<string, string> {
  const reasons = new Map<string, string>();
  for (const line of journalText.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row = JSON.parse(line) as {
        type?: string;
        label?: string;
        data?: { data?: { reasoning?: unknown } };
      };
      if (row.type !== "agent" || typeof row.label !== "string") continue;
      if (!row.label.startsWith("rubric:")) continue;
      const reasoning = asString(row.data?.data?.reasoning);
      if (reasoning !== null) reasons.set(row.label.slice("rubric:".length), reasoning);
    } catch {
      // skip unparseable journal lines — the report degrades gracefully
    }
  }
  return reasons;
}

/** Collect the explanation for `runId` (or the latest run). Null when no run exists. */
export async function gatherWhy(cwd: string, runId?: string): Promise<WhyData | null> {
  const ledgerPath = runId
    ? join(cwd, ".alfred", "workflows", runId, "ledger.jsonl")
    : await findLatestLedger(cwd);
  if (ledgerPath === null || !(await Bun.file(ledgerPath).exists())) return null;

  const runDir = dirname(ledgerPath);
  const rows = await new Ledger(ledgerPath, DEFAULT_LEDGER_SECRET).readAll();

  const journalFile = Bun.file(join(runDir, "journal.jsonl"));
  const journalText = (await journalFile.exists()) ? await journalFile.text() : null;
  const rubricReasons =
    journalText !== null ? rubricReasonsFromJournal(journalText) : new Map<string, string>();

  const features: WhyFeature[] = [];
  let runEnd: WhyData["runEnd"] = null;
  for (const row of rows) {
    const data = (row.data ?? {}) as Record<string, unknown>;
    if (row.kind === "feature") {
      const id = asString(data.feature) ?? "(unknown)";
      features.push({
        id,
        status: data.status === "passing" ? "passing" : "blocked",
        verifyExit: asNumber(data.verifyExit),
        rubric: asNumber(data.rubric),
        reason: asString(data.reason),
        rubricReasoning: rubricReasons.get(id) ?? null,
      });
    } else if (row.kind === "run_end") {
      runEnd = {
        passing: asNumber(data.passing) ?? 0,
        blocked: asNumber(data.blocked) ?? 0,
        stopped: asString(data.stopped) ?? "unknown",
      };
    }
  }

  return {
    runId: relative(join(cwd, ".alfred", "workflows"), runDir) || runDir,
    ledgerPath: relative(cwd, ledgerPath) || ledgerPath,
    journalPath: journalText !== null ? relative(cwd, join(runDir, "journal.jsonl")) : null,
    features,
    runEnd,
  };
}

/** Render the explanation (pure; blocked features first, with their evidence). */
export function renderWhy(d: WhyData, c: Palette): string {
  const lines: string[] = [];
  const summary = d.runEnd
    ? `${d.runEnd.passing} passing · ${d.runEnd.blocked} blocked (${d.runEnd.stopped})`
    : "no run_end row — the run may have been interrupted";
  lines.push(`${c.bold(`run ${d.runId}`)} — ${summary}`);
  lines.push("");

  const blocked = d.features.filter((f) => f.status === "blocked");
  const passing = d.features.filter((f) => f.status === "passing");

  if (d.features.length === 0) {
    lines.push(c.dim("no feature rows in this ledger."));
  }
  for (const f of blocked) {
    lines.push(c.red(`✗ ${f.id} blocked — ${f.reason ?? "no reason recorded"}`));
    if (f.verifyExit !== null) lines.push(`    verify exit: ${f.verifyExit}`);
    if (f.rubric !== null) lines.push(`    rubric: ${f.rubric}/2`);
    if (f.rubricReasoning !== null) lines.push(`    rubric says: ${f.rubricReasoning}`);
  }
  if (blocked.length > 0) lines.push("");
  for (const f of passing) {
    lines.push(
      c.green(`✓ ${f.id} passing`) +
        c.dim(` — verify exit ${f.verifyExit ?? "?"} · rubric ${f.rubric ?? "?"}/2`),
    );
  }

  lines.push("");
  lines.push(c.dim(`receipt: ${d.ledgerPath}`));
  lines.push(c.dim("  verify:  alfred ledger verify"));
  lines.push(c.dim(`  inspect: alfred ledger show`));
  if (d.journalPath !== null)
    lines.push(c.dim(`  journal: ${d.journalPath} (full agent transcript)`));
  return lines.join("\n");
}
