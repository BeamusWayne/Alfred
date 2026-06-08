/**
 * The autonomous harness, realised AS a workflow (ADR 0001 §5.3 / §7.7) — the
 * flagship that makes "verifiable autonomy" literally run.
 *
 * Deterministic state machine over feature_list.json:
 *   pick a feature → verify-fix inner loop (an implement agent drives real
 *   tools — optionally split into an architect plan + an editor apply, ADR 0005
 *   — then the OBJECTIVE verify gate runs `VERIFY_CMD` and trusts only its exit
 *   code) → a rubric self-eval guards against gaming → mark passing ONLY when
 *   BOTH verify exit == 0 AND rubric == 2 → append a signed, hash-chained
 *   ledger row (mirrored as an OTel span) + an episode record. Boxes are code.
 */
import { z } from "zod";
import { join } from "node:path";
import type { Runtime } from "../runtime.ts";
import type { Ledger } from "../ledger.ts";
import { EpisodeStore } from "../../memory/episodes.ts";
import { tracerFromEnv, GEN_AI_OPERATION_NAME } from "../../telemetry/otel.ts";
import {
  loadFeatureList,
  saveFeatureList,
  pickNext,
  markInProgress,
  markPassing,
  markBlocked,
  counts,
  type Feature,
} from "../../harness/featureList.ts";
import { runVerify, passed, type VerifyResult } from "../../harness/verify.ts";
import { checkpoint, rollback, currentSha, type Checkpoint } from "../../harness/checkpoint.ts";
import { bestOfNCode } from "./bestOfNCode.ts";

export const rubricSchema = z.object({
  verification: z.number().int().min(0).max(2),
  reasoning: z.string(),
});
export type Rubric = z.infer<typeof rubricSchema>;

const planSchema = z.object({ steps: z.array(z.string()) });
type Plan = z.infer<typeof planSchema>;

export type AutonomousEvent =
  | { readonly type: "feature_start"; readonly feature: Feature }
  | { readonly type: "attempt"; readonly featureId: string; readonly attempt: number }
  | { readonly type: "verify"; readonly featureId: string; readonly attempt: number; readonly exitCode: number; readonly passed: boolean }
  | { readonly type: "feature_passing"; readonly featureId: string }
  | { readonly type: "feature_blocked"; readonly featureId: string; readonly reason: string }
  | { readonly type: "run_end"; readonly passing: number; readonly blocked: number; readonly stopped: string };

export interface AutonomousRunOptions {
  readonly runtime: Runtime;
  readonly ledger: Ledger;
  readonly cwd: string;
  readonly featureListPath: string;
  readonly verifyCmd: string;
  readonly maxFeatures?: number;
  readonly maxConsecutiveBlocked?: number;
  readonly rollbackOnBlock?: boolean;
  /** When set and ≠ editorModel, a strong model plans (ADR 0005 architect step). */
  readonly architectModel?: string;
  /** The model that applies the change (ADR 0005 editor step). */
  readonly editorModel?: string;
  /** When > 1, each implement attempt runs N worktree-isolated candidates and
   * keeps the first that passes the verify gate (ADR 0001 §5.3 best-of-N). */
  readonly bestOfN?: number;
  /**
   * Per-attempt verify-gate timeout (ms). Without a bound, model-authored code
   * (an infinite loop, a hanging test, a never-resolving import) wedges the run
   * forever. Defaults to {@link DEFAULT_VERIFY_TIMEOUT_MS}.
   */
  readonly verifyTimeoutMs?: number;
  readonly onEvent?: (ev: AutonomousEvent) => void;
}

/** Default verify-gate timeout: generous for a real test suite, finite so a hung command cannot stall the run. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;

export interface AutonomousRunResult {
  readonly passing: number;
  readonly blocked: number;
  readonly stopped: "all_resolved" | "max_features" | "too_many_blocked";
  readonly ledgerOk: boolean;
}

function implementPrompt(
  feature: Feature,
  verifyCmd: string,
  feedback: string,
  steps: readonly string[],
): string {
  return [
    "You are implementing ONE feature in this codebase. Use the available tools",
    "(read, glob, grep, edit, write, bash) to make the change, then check it yourself.",
    "",
    `## Feature: ${feature.title}`,
    feature.description,
    "",
    steps.length > 0 ? `## Plan to follow\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n` : "",
    feedback ? `## Previous attempt feedback\n${feedback}\n` : "",
    `When you believe it is complete, stop. It will be checked by running: \`${verifyCmd}\``,
  ].join("\n");
}

function planPrompt(feature: Feature, feedback: string): string {
  return [
    "You are the architect. Produce a short, concrete implementation plan for the",
    "feature below — file paths to create/edit and the key steps. Do not write code.",
    "",
    `## Feature: ${feature.title}`,
    feature.description,
    "",
    feedback ? `## Previous attempt feedback\n${feedback}\n` : "",
    "Call structured_output with { steps: string[] }.",
  ].join("\n");
}

function rubricPrompt(feature: Feature, verify: VerifyResult | undefined): string {
  const out = verify ? `${verify.stdout}\n${verify.stderr}`.slice(0, 4000) : "(no verify run)";
  return [
    "Assess whether the following feature is genuinely and completely implemented.",
    "",
    `## Feature: ${feature.title}`,
    feature.description,
    "",
    `## Verify command exit code: ${verify?.exitCode ?? "n/a"}`,
    `## Verify output (truncated)\n${out}`,
    "",
    "Call structured_output with { verification, reasoning } where verification is",
    "2 = fully implemented AND the verify gate passed, 1 = partial, 0 = not done.",
    "Be strict: never score 2 unless the change is real and complete.",
  ].join("\n");
}

export async function autonomousRun(opts: AutonomousRunOptions): Promise<AutonomousRunResult> {
  const maxBlocked = opts.maxConsecutiveBlocked ?? 2;
  const useSplit = Boolean(
    opts.architectModel && opts.editorModel && opts.architectModel !== opts.editorModel,
  );
  const episodes = new EpisodeStore(join(opts.cwd, ".alfred", "memory", "episodes"));
  const tracer = tracerFromEnv();

  let list = await loadFeatureList(opts.featureListPath);
  let consecutiveBlocked = 0;
  let processed = 0;
  let stopped: AutonomousRunResult["stopped"] = "all_resolved";

  for (;;) {
    const feature = pickNext(list);
    if (feature === null) {
      stopped = "all_resolved";
      break;
    }
    if (opts.maxFeatures !== undefined && processed >= opts.maxFeatures) {
      stopped = "max_features";
      break;
    }
    processed++;

    list = markInProgress(list, feature.id);
    await saveFeatureList(opts.featureListPath, list);
    opts.onEvent?.({ type: "feature_start", feature });

    const cp: Checkpoint | null = opts.rollbackOnBlock ? await checkpoint(opts.cwd) : null;

    const iterationBudget = feature.iterationBudget ?? 3;
    let verify: VerifyResult | undefined;
    let feedback = "";
    for (let attempt = 1; attempt <= iterationBudget; attempt++) {
      opts.onEvent?.({ type: "attempt", featureId: feature.id, attempt });
      if (opts.bestOfN && opts.bestOfN > 1) {
        const fb = feedback;
        await bestOfNCode({
          cwd: opts.cwd,
          n: opts.bestOfN,
          verifyCmd: opts.verifyCmd,
          verifyTimeoutMs: opts.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
          implement: async (worktreePath, candidate) => {
            await opts.runtime.agent(
              `${implementPrompt(feature, opts.verifyCmd, fb, [])}\n\n(Candidate ${candidate + 1} — explore a distinct approach.)`,
              {
                permissions: { mode: "bypass", allowedTools: new Set(), deniedTools: new Set(), workingDir: worktreePath },
                label: `bestof:${feature.id}#${attempt}.${candidate}`,
              },
            );
          },
        });
      } else if (useSplit) {
        const plan = await opts.runtime.agent<Plan>(planPrompt(feature, feedback), {
          schema: planSchema,
          model: opts.architectModel,
          label: `architect:${feature.id}#${attempt}`,
        });
        await opts.runtime.agent(implementPrompt(feature, opts.verifyCmd, feedback, plan.data?.steps ?? []), {
          model: opts.editorModel,
          label: `editor:${feature.id}#${attempt}`,
        });
      } else {
        await opts.runtime.agent(implementPrompt(feature, opts.verifyCmd, feedback, []), {
          label: `implement:${feature.id}#${attempt}`,
        });
      }
      verify = await runVerify(opts.verifyCmd, {
        cwd: opts.cwd,
        timeoutMs: opts.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
      });
      opts.onEvent?.({ type: "verify", featureId: feature.id, attempt, exitCode: verify.exitCode, passed: passed(verify) });
      if (passed(verify)) break;
      feedback =
        `Attempt ${attempt} failed the verify gate (exit ${verify.exitCode}).\n` +
        `stderr:\n${verify.stderr.slice(0, 3000)}\nstdout:\n${verify.stdout.slice(0, 1000)}`;
    }

    const rubricRun = await opts.runtime.agent<Rubric>(rubricPrompt(feature, verify), {
      schema: rubricSchema,
      label: `rubric:${feature.id}`,
    });
    const rubric = rubricRun.data;
    const verifyOk = verify !== undefined && passed(verify);
    const rubricOk = rubric?.verification === 2;
    const featurePassed = verifyOk && rubricOk;
    const gitSha = await currentSha(opts.cwd);
    const reason = featurePassed
      ? ""
      : !verifyOk
        ? `verify exit ${verify?.exitCode ?? "n/a"}`
        : `rubric ${rubric?.verification ?? "null"}`;

    if (featurePassed) {
      list = markPassing(list, feature.id);
      consecutiveBlocked = 0;
    } else {
      list = markBlocked(list, feature.id);
      consecutiveBlocked++;
      if (cp && opts.rollbackOnBlock) {
        try {
          await rollback(opts.cwd, cp);
        } catch {
          // best-effort; a failed rollback must not crash the run
        }
      }
    }

    // Signed receipt row (ADR 0001 §5.3) — secrets are redacted inside the ledger.
    await opts.ledger.append("feature", {
      feature: feature.id,
      status: featurePassed ? "passing" : "blocked",
      verifyExit: verify?.exitCode ?? -1,
      rubric: rubric?.verification ?? null,
      gitSha,
      ...(reason ? { reason } : {}),
    });
    // Ledger-as-spans (ADR 0004): mirror the receipt row as an OTel span.
    tracer
      .startSpan("feature", {
        [GEN_AI_OPERATION_NAME]: "invoke_agent",
        feature: feature.id,
        status: featurePassed ? "passing" : "blocked",
        verifyExit: verify?.exitCode ?? -1,
        rubric: rubric?.verification ?? -1,
      })
      .end();
    // Episode record (ADR 0001 §4) — the bridge to self-improvement.
    await episodes.write({
      goal: `${feature.id}: ${feature.title}`,
      approach: useSplit ? "architect/editor + verify-fix" : "verify-fix",
      worked: featurePassed ? [feature.id] : [],
      failed: featurePassed ? [] : [reason || "blocked"],
      verifyExit: verify ? String(verify.exitCode) : undefined,
      gitSha: gitSha ?? undefined,
      cost: opts.runtime.budgetSnapshot().usd,
    });

    opts.onEvent?.(
      featurePassed
        ? { type: "feature_passing", featureId: feature.id }
        : { type: "feature_blocked", featureId: feature.id, reason },
    );
    await saveFeatureList(opts.featureListPath, list);

    if (consecutiveBlocked >= maxBlocked) {
      stopped = "too_many_blocked";
      break;
    }
  }

  const c = counts(list);
  await opts.ledger.append("run_end", { passing: c.passing, blocked: c.blocked, stopped });
  const v = await opts.ledger.verify();
  opts.onEvent?.({ type: "run_end", passing: c.passing, blocked: c.blocked, stopped });
  return { passing: c.passing, blocked: c.blocked, stopped, ledgerOk: v.ok };
}
