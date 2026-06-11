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

import { join } from "node:path";
import { z } from "zod";
import { modelProfile, tierIterationBudget } from "../../config/modelCatalog.ts";
import { type Checkpoint, checkpoint, currentSha, rollback } from "../../harness/checkpoint.ts";
import {
  counts,
  type Feature,
  loadFeatureList,
  markBlocked,
  markInProgress,
  markPassing,
  pickNext,
  saveFeatureList,
  setStatus,
} from "../../harness/featureList.ts";
import { passed, runVerify, type VerifyResult } from "../../harness/verify.ts";
import { EpisodeStore } from "../../memory/episodes.ts";
import { GEN_AI_OPERATION_NAME, tracerFromEnv } from "../../telemetry/otel.ts";
import { fileReadTool } from "../../tools/fileRead.ts";
import { globTool } from "../../tools/glob.ts";
import { grepTool } from "../../tools/grep.ts";
import type { Ledger } from "../ledger.ts";
import type { Runtime } from "../runtime.ts";
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
  | {
      readonly type: "verify";
      readonly featureId: string;
      readonly attempt: number;
      readonly exitCode: number;
      readonly passed: boolean;
      /** Which gate ran: the fast pre-filter or the authoritative full gate. */
      readonly gate: "fast" | "full";
    }
  | { readonly type: "feature_passing"; readonly featureId: string }
  | { readonly type: "feature_blocked"; readonly featureId: string; readonly reason: string }
  | {
      readonly type: "run_end";
      readonly passing: number;
      readonly blocked: number;
      readonly stopped: string;
    };

export interface AutonomousRunOptions {
  readonly runtime: Runtime;
  readonly ledger: Ledger;
  readonly cwd: string;
  readonly featureListPath: string;
  readonly verifyCmd: string;
  /**
   * Optional fast pre-gate (e.g. the affected test file only). A fast-gate
   * failure short-circuits straight back into the fix loop without paying for
   * the full suite; a fast-gate pass still runs `verifyCmd` — ONLY the full
   * gate's exit 0 can mark a feature passing.
   */
  readonly fastVerifyCmd?: string;
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
  /**
   * Operator interrupt (Ctrl-C). When it fires, the run STOPS truthfully:
   * the in-flight feature reverts to pending (an interrupt is not a feature
   * failure), no feature receipt row is signed, and run_end records
   * stopped="aborted". Without this, dead-signal attempts grind on and
   * fabricate a blocked receipt (observed live).
   */
  readonly signal?: AbortSignal;
  readonly onEvent?: (ev: AutonomousEvent) => void;
}

/** Default verify-gate timeout: generous for a real test suite, finite so a hung command cannot stall the run. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;

export interface AutonomousRunResult {
  readonly passing: number;
  readonly blocked: number;
  readonly stopped: "all_resolved" | "max_features" | "too_many_blocked" | "error" | "aborted";
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
    steps.length > 0
      ? `## Plan to follow\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n`
      : "",
    feedback ? `## Previous attempt feedback\n${feedback}\n` : "",
    "This run is unattended: never ask questions or wait for confirmation. For any minor",
    "decision, pick a reasonable option and continue — the verify gate is the sole arbiter.",
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
    "Use the read-only tools (glob, file_read, grep) to inspect the ACTUAL files",
    "and confirm the implementation exists and matches the description — do not",
    "judge from the verify output alone (it may be empty on success).",
    "",
    "Then call structured_output with { verification, reasoning } where verification is",
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

  const interrupted = () => opts.signal?.aborted === true;

  for (;;) {
    if (interrupted()) {
      stopped = "aborted";
      break;
    }
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

    // Per-feature override → tier default for the model doing the implementing
    // (frontier converges in 1-2 attempts; small models need more rounds).
    const implementModel = opts.editorModel ?? opts.runtime.model;
    const iterationBudget =
      feature.iterationBudget ?? tierIterationBudget(modelProfile(implementModel).tier);
    let verify: VerifyResult | undefined;
    let feedback = "";
    let rubric: Rubric | null = null;
    let aborted: string | null = null;
    try {
      for (let attempt = 1; attempt <= iterationBudget; attempt++) {
        if (interrupted()) break;
        opts.onEvent?.({ type: "attempt", featureId: feature.id, attempt });
        if (opts.bestOfN && opts.bestOfN > 1) {
          const fb = feedback;
          // Honor the architect/editor split (ADR 0005) inside best-of-N: plan
          // once with the architect, then run N editor candidates against it,
          // instead of silently dropping the operator's split-model intent.
          const steps = useSplit
            ? ((
                await opts.runtime.agent<Plan>(planPrompt(feature, feedback), {
                  schema: planSchema,
                  model: opts.architectModel,
                  role: "architect",
                  label: `architect:${feature.id}#${attempt}`,
                })
              ).data?.steps ?? [])
            : [];
          await bestOfNCode({
            cwd: opts.cwd,
            n: opts.bestOfN,
            verifyCmd: opts.verifyCmd,
            verifyTimeoutMs: opts.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
            implement: async (worktreePath, candidate) => {
              await opts.runtime.agent(
                `${implementPrompt(feature, opts.verifyCmd, fb, steps)}\n\n(Candidate ${candidate + 1} — explore a distinct approach.)`,
                {
                  ...(useSplit ? { model: opts.editorModel, role: "editor" as const } : {}),
                  permissions: {
                    mode: "bypass",
                    allowedTools: new Set(),
                    deniedTools: new Set(),
                    workingDir: worktreePath,
                  },
                  label: `bestof:${feature.id}#${attempt}.${candidate}`,
                },
              );
            },
          });
        } else if (useSplit) {
          const plan = await opts.runtime.agent<Plan>(planPrompt(feature, feedback), {
            schema: planSchema,
            model: opts.architectModel,
            role: "architect",
            label: `architect:${feature.id}#${attempt}`,
          });
          await opts.runtime.agent(
            implementPrompt(feature, opts.verifyCmd, feedback, plan.data?.steps ?? []),
            {
              model: opts.editorModel,
              role: "editor",
              label: `editor:${feature.id}#${attempt}`,
            },
          );
        } else {
          await opts.runtime.agent(implementPrompt(feature, opts.verifyCmd, feedback, []), {
            label: `implement:${feature.id}#${attempt}`,
          });
        }
        // An interrupt mid-implement must not pay for a (full-suite) verify.
        if (interrupted()) break;

        // Fast pre-gate: a cheap failure signal (affected tests, lint, tsc)
        // short-circuits back into the fix loop without paying for the full
        // suite. It can only reject — never accept.
        if (opts.fastVerifyCmd) {
          const fast = await runVerify(opts.fastVerifyCmd, {
            cwd: opts.cwd,
            timeoutMs: opts.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
          });
          opts.onEvent?.({
            type: "verify",
            featureId: feature.id,
            attempt,
            exitCode: fast.exitCode,
            passed: passed(fast),
            gate: "fast",
          });
          if (!passed(fast)) {
            verify = fast;
            feedback =
              `Attempt ${attempt} failed the FAST verify gate (exit ${fast.exitCode}): \`${opts.fastVerifyCmd}\`.\n` +
              `stderr:\n${fast.stderr.slice(0, 3000)}\nstdout:\n${fast.stdout.slice(0, 1000)}`;
            continue;
          }
        }

        verify = await runVerify(opts.verifyCmd, {
          cwd: opts.cwd,
          timeoutMs: opts.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
        });
        opts.onEvent?.({
          type: "verify",
          featureId: feature.id,
          attempt,
          exitCode: verify.exitCode,
          passed: passed(verify),
          gate: "full",
        });
        if (passed(verify)) break;
        feedback =
          `Attempt ${attempt} failed the verify gate (exit ${verify.exitCode}).\n` +
          `stderr:\n${verify.stderr.slice(0, 3000)}\nstdout:\n${verify.stdout.slice(0, 1000)}`;
      }

      if (!interrupted()) {
        const rubricRun = await opts.runtime.agent<Rubric>(rubricPrompt(feature, verify), {
          schema: rubricSchema,
          role: "subagent",
          // Evidence access: the judge inspects the real files instead of scoring
          // from a possibly-empty verify output (which biased strict models to 0).
          tools: [fileReadTool, globTool, grepTool],
          label: `rubric:${feature.id}`,
        });
        rubric = rubricRun.data;
      }
    } catch (err) {
      // A throw mid-feature (budget exhausted, provider/abort error) must not
      // crash the whole run with an unhandled rejection and leave the feature
      // stuck in_progress with no run_end in the ledger. Fall through: record
      // this feature as blocked below, then stop the run gracefully so the
      // terminal run_end receipt is still written.
      aborted = err instanceof Error ? err.message : String(err);
    }

    // Operator interrupt: not a feature failure. Revert to pending (the
    // feature is rerunnable), sign NO feature row, and stop — run_end below
    // records stopped="aborted". This is the truthful-receipt path for ^C.
    if (interrupted()) {
      list = setStatus(list, feature.id, "pending");
      await saveFeatureList(opts.featureListPath, list);
      stopped = "aborted";
      break;
    }

    const verifyOk = verify !== undefined && passed(verify);
    const rubricOk = rubric?.verification === 2;
    const featurePassed = aborted === null && verifyOk && rubricOk;
    const gitSha = await currentSha(opts.cwd);
    const reason = featurePassed
      ? ""
      : aborted !== null
        ? `aborted: ${aborted}`
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

    if (aborted !== null) {
      // Stop gracefully after recording the blocked feature — further model
      // calls would just throw again (e.g. budget already exhausted).
      stopped = "error";
      break;
    }
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
