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
import { runAgent, type AgentRun } from "./agent.ts";
import type { Journal } from "./journal.ts";
import { Budget, type BudgetLimits, type BudgetSnapshot } from "./budget.ts";
import type { Provider } from "../providers/types.ts";
import type { ToolPermissionContext } from "../permissions/types.ts";
import type { Tool } from "../tools/types.ts";
import type { Role } from "../config/roles.ts";

const DEFAULT_CONCURRENCY = 4;

export interface RuntimeOptions {
  readonly provider: Provider;
  readonly model: string;
  readonly permissions: ToolPermissionContext;
  readonly journal?: Journal;
  readonly budget?: BudgetLimits;
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly onLog?: (message: string) => void;
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
      });
    } finally {
      sem.release();
    }

    if (run.cost) budget = budget.record(callOpts.model ?? opts.model, run.cost.usage);
    if (journal) {
      await journal.append({ type: "agent", key: callOpts.key, label: callOpts.label ?? "agent", data: run });
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
    if (journal) journal.append({ type: "log", label: "log", data: { message } }).catch(() => undefined);
  };

  return {
    runId,
    model: opts.model,
    agent,
    parallel,
    pipeline,
    log,
    budgetSnapshot: () => budget.snapshot(),
  };
}
