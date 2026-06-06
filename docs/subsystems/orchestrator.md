# Orchestrator

The orchestrator is Alfred's dynamic-workflow runtime. It provides four primitives — `agent()`, `parallel()`, `pipeline()`, and `log()` — that let hand-wired TypeScript code compose multi-step agent workflows. Control flow is always code; the model fills the boxes that the code defines.

**Source files:** `src/orchestrator/runtime.ts`, `src/orchestrator/agent.ts`, `src/orchestrator/journal.ts`, `src/orchestrator/budget.ts`, `src/orchestrator/ledger.ts`, `src/orchestrator/workflows/bestOfN.ts`.  
**Design:** ADR 0001 §5.

---

## Primitives

### `Runtime` interface

```ts
interface Runtime {
  readonly runId: string;
  agent<T = unknown>(prompt: string, opts?: AgentCallOptions): Promise<AgentRun<T>>;
  parallel<T>(thunks: ReadonlyArray<() => Promise<T>>): Promise<T[]>;
  pipeline<T = unknown>(items: readonly unknown[], ...stages: readonly Stage[]): Promise<T[]>;
  log(message: string): void;
  budgetSnapshot(): BudgetSnapshot;
}
```

Instances are created with `createRuntime(runId, opts)` in `src/orchestrator/runtime.ts`.

### `agent(prompt, opts?)`

Runs the query engine over an isolated message list. Internally calls `runAgent` from `src/orchestrator/agent.ts`, which drains the `runQuery` async generator without leaking events to the workflow. Returns `AgentRun<T>`:

```ts
interface AgentRun<T = unknown> {
  readonly text: string;    // concatenated last-assistant text blocks
  readonly data: T | null;  // validated structured output (schema mode)
  readonly status: TerminalStatus;
  readonly cost: QueryState["cost"];
  readonly turns: number;
}
```

**Structured output mode:** when `opts.schema` is a Zod type, `runAgent` injects a synthetic `structured_output` tool whose `call` captures validated input into a closure variable. A suffix is appended to the system prompt instructing the model to call this tool with the final answer. If the model returns JSON text instead of calling the tool, `runAgent` attempts `JSON.parse` + `schema.safeParse` as a fallback. `data` is `null` if both paths fail.

**Resume:** if `opts.key` is provided and the journal holds an entry with that key, the cached `AgentRun` is returned without re-running the model.

### `parallel(thunks)`

```ts
const parallel = <T>(thunks: ReadonlyArray<() => Promise<T>>): Promise<T[]> =>
  Promise.all(thunks.map((t) => t()));
```

`Promise.all` over the thunks. Concurrency is bounded by the shared semaphore inside `agent()`, not here. `parallel()` itself does no throttling — it simply launches all thunks and the semaphore queues any overflow.

### `pipeline(items, ...stages)`

Applies a sequence of async `Stage` functions to each item independently and in parallel. Each stage receives `(accumulator, originalItem, index)`. Returns a `T[]` of final values in original order.

```ts
type Stage = (prev: unknown, item: unknown, index: number) => Promise<unknown>;
```

### `log(message)`

Emits the message to `opts.onLog` (if provided) and appends a `{ type: "log" }` entry to the journal (fire-and-forget via `void`).

---

## Concurrency semaphore

`createRuntime` creates one counting semaphore (`createSemaphore`) with a default limit of **4** concurrent agent slots. The semaphore is shared across all `agent()` calls from the runtime, including those nested inside `parallel()` and `pipeline()`.

```text
  parallel([ thunk1, thunk2, thunk3, thunk4, thunk5 ])
      │
      ├─ thunk1 → sem.acquire() → runs
      ├─ thunk2 → sem.acquire() → runs
      ├─ thunk3 → sem.acquire() → runs
      ├─ thunk4 → sem.acquire() → runs
      └─ thunk5 → sem.acquire() → waits (slot full)
                                     → released when any of 1-4 finishes
```

The semaphore is acquired before `runAgent` and released in a `finally` block, so it is always released even if the agent call throws.

---

## Append-only journal (resume / replay)

`Journal` in `src/orchestrator/journal.ts` writes one JSONL line per completed step to a file. Every write is serialised through a promise chain (`writeQueue`) so concurrent `append()` calls never interleave.

### `JournalEntry` shape

```ts
interface JournalEntry {
  readonly seq: number;    // monotonically increasing, initialised from file on first write
  readonly type: string;   // "agent" | "log" | ...
  readonly key?: string;   // optional deterministic step key for resume
  readonly label?: string;
  readonly data: unknown;
  readonly ts: number;     // Date.now() at write time
}
```

### Resume

`findByKey(key)` reads all lines and returns the last entry whose `key` matches. `createRuntime`'s `agent()` checks this before invoking the model:

```ts
if (journal && callOpts.key) {
  const cached = await journal.findByKey(callOpts.key);
  if (cached) return cached.data as AgentRun<T>;
}
```

If a step with the given key already completed, its result is returned immediately without any model call. This makes replaying a partially-completed workflow safe and cheap.

### Replay tape

`readAll()` returns all entries in sequence order. The full JSONL file is a self-contained record of the run's history: every agent step (with full `AgentRun` payload), every log message, and (in the harness) every ledger row.

---

## Token and cost budget

`Budget` in `src/orchestrator/budget.ts` wraps `CostTracker` (from `src/cost/tracker.ts`) with hard limits. It is **immutable**: every mutating operation returns a new `Budget` instance.

```ts
interface BudgetLimits {
  maxUsd?: number;      // hard USD ceiling
  maxTokens?: number;   // hard token ceiling (input + output + cache)
}
```

After each `agent()` call returns, the runtime records usage:

```ts
if (run.cost) budget = budget.record(callOpts.model ?? opts.model, run.cost.usage);
```

Before each `agent()` call, it checks:

```ts
if (budget.exceeded()) {
  throw new Error(`orchestration budget exceeded: ${JSON.stringify(budget.snapshot())}`);
}
```

`exceeded()` returns `true` when at least one configured limit is at or above the spend. When no limits are configured, it always returns `false`.

`budgetSnapshot()` returns an immutable `{ usd, tokens, limits }` point-in-time snapshot for inspection or logging.

---

## HMAC hash-chained ledger

`Ledger` in `src/orchestrator/ledger.ts` provides tamper-evident persistence of harness step records. Each entry in the JSONL file carries its own HMAC-SHA256 signature and a reference to the previous entry's signature, forming a hash chain.

### Entry structure

```ts
interface LedgerEntry {
  readonly seq: number;
  readonly kind: string;
  readonly ts: number;
  readonly data: Record<string, unknown>;
  readonly prevSig: string;   // sig of the previous entry (or 64-zero genesis anchor)
  readonly sig: string;       // HMAC-SHA256 of canonical(payload) + prevSig
}
```

### How signing works

1. The payload (`seq`, `kind`, `ts`, `data`) is serialised with **deterministic key ordering** (`canonicalise()`). Standard `JSON.stringify` has insertion-order-dependent key order; `canonicalise` recursively sorts object keys to produce a stable string regardless of construction order.
2. The HMAC input is `canonicalise(payload) + prevSig`.
3. HMAC-SHA256 is computed with `node:crypto`'s `createHmac`, output as lowercase hex.
4. The genesis entry (seq 0) uses `"0".repeat(64)` as `prevSig`.

### `verify()` — tamper detection

`verify()` reads all entries and checks three invariants for each:

1. **Sequence integrity:** `entry.seq === index` in the array.
2. **Chain link:** `entry.prevSig` equals the previous entry's `sig` (or the genesis constant for seq 0).
3. **Signature integrity:** recomputing `signEntry` with the entry's own fields must equal `entry.sig`.

Any edit, deletion, reordering, or truncation of the JSONL file breaks at least one of these checks. `verify()` returns `{ ok: true }` or `{ ok: false; brokenAt: number; reason: string }`.

The harness calls `verify()` after the run completes and includes `ledgerOk` in its result:

```ts
const v = await opts.ledger.verify();
return { passing, blocked, stopped, ledgerOk: v.ok };
```

### Write serialisation

Like `Journal`, all `append()` calls are chained through a `writeQueue` promise so concurrent writes never interleave their read-then-write sequences.

---

## Best-of-N inference-time scaling

`bestOfN` in `src/orchestrator/workflows/bestOfN.ts` generates `N` independent candidate outputs in parallel and returns the highest-scoring one.

```ts
interface BestOfNOptions<T> {
  runtime: Runtime;
  n: number;
  prompt: string;
  schema: z.ZodType<T>;
  score: (candidate: T, run: AgentRun<T>) => Promise<number> | number;
  systemPrompt?: string;
  model?: string;
  labelPrefix?: string;
}
```

Each candidate receives a deterministic variant suffix `"(Candidate variant N of M; explore a distinct approach.)"` appended to the base prompt. This is not random — the suffix is purely ordinal — so the only source of variation is the model's own sampling.

All candidates are submitted via `runtime.parallel`, so they queue through the shared semaphore. `null` candidates (structured output failed) automatically score `-Infinity` without invoking the scorer.

```text
bestOfN({ n: 3, prompt, schema, score })
  │
  ├─ runtime.parallel([
  │    () => runtime.agent(prompt + "variant 1 of 3", { schema })
  │    () => runtime.agent(prompt + "variant 2 of 3", { schema })
  │    () => runtime.agent(prompt + "variant 3 of 3", { schema })
  │  ])
  │
  ├─ score each non-null candidate
  └─ return { best, bestScore, candidates }
```

Ties (equal score) resolve to the lowest original index because `Array.reduce` is left-to-right and the loop uses `>` (strict greater-than).

---

## `RuntimeOptions` reference

```ts
interface RuntimeOptions {
  readonly provider: Provider;
  readonly model: string;
  readonly permissions: ToolPermissionContext;
  readonly journal?: Journal;
  readonly budget?: BudgetLimits;
  readonly concurrency?: number;    // default 4
  readonly signal?: AbortSignal;
  readonly onLog?: (message: string) => void;
}
```

---

## See also

- [Agent Loop](/subsystems/agent-loop) — `runQuery` is the engine `runAgent` wraps
- [Harness](/subsystems/harness) — `autonomousRun` is the flagship workflow that uses all these primitives
- ADR 0001 §5 — design rationale for dynamic workflows, journal, and best-of-N
