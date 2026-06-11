/**
 * Orchestrator runtime — ADR 0001 §5.
 *
 * The deterministic dynamic-workflow primitives (agent / parallel / pipeline /
 * log) over the existing engine. Control flow is hand-wired code; the model
 * only fills the boxes (ADR 0001 P3). Every agent step is journaled (resume +
 * replay tape) and metered against a token/cost budget; total concurrency is
 * bounded by a single semaphore so nested fan-out can't overwhelm a CLI.
 */
import type { ZodTypeAny } from "zod";
import type { Role } from "../config/roles.ts";
import type { ToolPermissionContext } from "../permissions/types.ts";
import type { Provider } from "../providers/types.ts";
import type { QueryEvent } from "../query/types.ts";
import type { Tool } from "../tools/types.ts";
import { type AgentRun, runAgent } from "./agent.ts";
import { Budget, type BudgetLimits, type BudgetSnapshot } from "./budget.ts";
import type { Journal } from "./journal.ts";

const DEFAULT_CONCURRENCY = 4;

/**
 * A tool-level progress beat from a running agent — the data behind live
 * panels (`alfred watch`, the `alfred run` footer). Deliberately tiny:
 * the human label of the call, never tool input or output payloads (those
 * stay in the engine transcript; the journal's agent row has the result).
 */
export interface AgentActivity {
  readonly label: string;
  readonly event: "tool_use" | "tool_result" | "turn";
  readonly name: string;
  /** Human call label (`bash(bun test)`) — present on tool_use. */
  readonly describe?: string;
  /** Present on tool_result. */
  readonly isError?: boolean;
  /** Running spend of the in-flight agent — present on turn. */
  readonly costUsd?: number;
}

export interface RuntimeOptions {
  readonly provider: Provider;
  readonly model: string;
  readonly permissions: ToolPermissionContext;
  readonly journal?: Journal;
  readonly budget?: BudgetLimits;
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly onLog?: (message: string) => void;
  /** Live tool-level progress from every agent() call (see AgentActivity). */
  readonly onActivity?: (activity: AgentActivity) => void;
}

export interface AgentCallOptions {
  readonly schema?: ZodTypeAny;
  readonly tools?: readonly Tool[];
  readonly systemPrompt?: string;
  readonly model?: string;
  readonly maxTurns?: number;
  readonly label?: string;
  /** Role for effort defaults (architect=xhigh … subagent=low, ADR 0005). */
  readonly role?: Role;
  /** Per-call permission override (e.g. a worktree workingDir for best-of-N). */
  readonly permissions?: ToolPermissionContext;
  /** Resume key: if the journal already holds a result for this key, reuse it. */
  readonly key?: string;
}

export type Stage = (prev: unknown, item: unknown, index: number) => Promise<unknown>;

export interface Runtime {
  readonly runId: string;
  /** The default model agent() uses when a call doesn't override it. */
  readonly model: string;
  agent<T = unknown>(prompt: string, opts?: AgentCallOptions): Promise<AgentRun<T>>;
  parallel<T>(thunks: ReadonlyArray<() => Promise<T>>): Promise<T[]>;
  pipeline<T = unknown>(items: readonly unknown[], ...stages: readonly Stage[]): Promise<T[]>;
  log(message: string): void;
  budgetSnapshot(): BudgetSnapshot;
  /** Settled budget spend PLUS the latest per-turn tally of in-flight agents. */
  liveCostUsd(): number;
}

interface Semaphore {
  acquire(): Promise<void>;
  release(): void;
}

/** A minimal counting semaphore — bounds total concurrent agent() calls. */
function createSemaphore(max: number): Semaphore {
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    acquire(): Promise<void> {
      if (active < max) {
        active++;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        waiters.push(() => {
          active++;
          resolve();
        });
      });
    },
    release(): void {
      active--;
      const next = waiters.shift();
      if (next) next();
    },
  };
}

export function createRuntime(runId: string, opts: RuntimeOptions): Runtime {
  const sem = createSemaphore(opts.concurrency ?? DEFAULT_CONCURRENCY);
  const { journal } = opts;
  let budget = new Budget(opts.budget);
  // Latest per-turn spend of each in-flight agent call, keyed by a unique
  // call id (labels can repeat across attempts). Cleared when the call's
  // cost settles into the budget, so liveCostUsd never double-counts.
  const inflightUsd = new Map<number, number>();
  let nextCallId = 0;

  const agent = async <T = unknown>(
    prompt: string,
    callOpts: AgentCallOptions = {},
  ): Promise<AgentRun<T>> => {
    // Resume: a completed step returns its cached result without re-running.
    if (journal && callOpts.key) {
      const cached = await journal.findByKey(callOpts.key);
      if (cached) return cached.data as AgentRun<T>;
    }
    if (budget.exceeded()) {
      throw new Error(`orchestration budget exceeded: ${JSON.stringify(budget.snapshot())}`);
    }

    // Surface the REMAINING orchestration budget to the model (task_budget,
    // beta): instead of being cut off when the harness budget runs dry, a
    // capable model sees the countdown and wraps up gracefully.
    const remainingTokens =
      opts.budget?.maxTokens !== undefined
        ? Math.max(0, opts.budget.maxTokens - budget.snapshot().tokens)
        : undefined;

    // Live activity tap: surface tool beats to the caller and journal them
    // as they happen, so a panel attached mid-run sees motion, not silence.
    // Writes are fire-and-forget (same contract as log()): a progress write
    // must never crash or slow the run. Only label/name/describe persist —
    // never tool input or output payloads.
    const label = callOpts.label ?? "agent";
    const callId = nextCallId++;
    const onEvent = (ev: QueryEvent): void => {
      let activity: AgentActivity;
      if (ev.type === "tool_use") {
        activity = { label, event: "tool_use", name: ev.name, describe: ev.describe };
      } else if (ev.type === "tool_result") {
        activity = { label, event: "tool_result", name: ev.name, isError: ev.isError };
      } else if (ev.type === "turn") {
        inflightUsd.set(callId, ev.costUsd);
        activity = { label, event: "turn", name: "model", costUsd: ev.costUsd };
      } else {
        return;
      }
      opts.onActivity?.(activity);
      if (journal) {
        journal.append({ type: "activity", label, data: { ...activity } }).catch(() => undefined);
      }
    };

    await sem.acquire();
    let run: AgentRun<T>;
    try {
      run = await runAgent<T>(prompt, {
        provider: opts.provider,
        model: callOpts.model ?? opts.model,
        permissions: callOpts.permissions ?? opts.permissions,
        schema: callOpts.schema,
        tools: callOpts.tools,
        systemPrompt: callOpts.systemPrompt,
        maxTurns: callOpts.maxTurns,
        signal: opts.signal,
        role: callOpts.role,
        taskBudgetTokens: remainingTokens,
        onEvent,
      });
    } finally {
      sem.release();
    }

    // Settle: the run's cost enters the budget; its in-flight tally retires.
    if (run.cost) budget = budget.record(callOpts.model ?? opts.model, run.cost.usage);
    inflightUsd.delete(callId);
    if (journal) {
      await journal.append({
        type: "agent",
        key: callOpts.key,
        label: callOpts.label ?? "agent",
        data: run,
      });
    }
    return run;
  };

  // Concurrency is enforced inside agent() via the shared semaphore, so
  // parallel()/pipeline() simply launch the work and let it queue.
  const parallel = <T>(thunks: ReadonlyArray<() => Promise<T>>): Promise<T[]> =>
    Promise.all(thunks.map((t) => t()));

  const pipeline = <T = unknown>(
    items: readonly unknown[],
    ...stages: readonly Stage[]
  ): Promise<T[]> =>
    Promise.all(
      items.map(async (item, index) => {
        let acc: unknown = item;
        for (const stage of stages) {
          acc = await stage(acc, item, index);
        }
        return acc as T;
      }),
    );

  const log = (message: string): void => {
    opts.onLog?.(message);
    // Fire-and-forget: a log write must never surface as an unhandled rejection
    // (which can crash the run). Swallow — the message already went to onLog.
    if (journal)
      journal.append({ type: "log", label: "log", data: { message } }).catch(() => undefined);
  };

  return {
    runId,
    model: opts.model,
    agent,
    parallel,
    pipeline,
    log,
    budgetSnapshot: () => budget.snapshot(),
    liveCostUsd: () => {
      let inflight = 0;
      for (const usd of inflightUsd.values()) inflight += usd;
      return budget.snapshot().usd + inflight;
    },
  };
}
