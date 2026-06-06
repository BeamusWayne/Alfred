# Harness

The autonomous harness is Alfred's flagship capability: a verifiable, auditable feature-implementation loop. It drives a deterministic state machine over `feature_list.json`, attempts each feature with a real coding agent, gates completion on an **objective exit-code check** and a **model rubric**, and records every outcome in a tamper-evident signed ledger.

**Source files:** `src/harness/featureList.ts`, `src/harness/verify.ts`, `src/harness/checkpoint.ts`, `src/orchestrator/workflows/autonomousRun.ts`.  
**Design:** ADR 0001 §5.3 / §7.7.

---

## Concepts

The core insight is that the model is never trusted to declare its own work "done." Two independent gates must both pass before a feature transitions to `passing`:

1. **Objective verify gate** — run the user-supplied `VERIFY_CMD` as a shell command and require exit code 0.
2. **Rubric self-eval gate** — a separate agent instance scores the implementation on a 0/1/2 scale; only score 2 advances the feature.

Both gates must pass. Either alone is insufficient.

---

## Feature list state machine

### `Feature` and `FeatureList` shapes

```ts
interface Feature {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: FeatureStatus;    // "pending" | "in_progress" | "passing" | "blocked"
  readonly priority?: number;        // lower number = higher priority
  readonly iterationBudget?: number; // max implement-verify attempts (default 3)
  readonly deps?: readonly string[]; // ids of features that must be "passing" first
}
```

Features are stored in a JSON file (typically `feature_list.json`) validated on load by Zod (`featureListSchema`).

### Status transitions

```text
        ┌──────────┐
  start │  pending  │
        └──────────┘
              │  pickNext() selects it
              ▼
        ┌────────────┐
        │ in_progress│
        └────────────┘
          │          │
          │ both     │ verify exit≠0 OR rubric<2
          │ gates ok │ (after iterationBudget attempts)
          ▼          ▼
        ┌─────────┐  ┌─────────┐
        │ passing │  │ blocked │
        └─────────┘  └─────────┘
```

All transition functions (`markInProgress`, `markPassing`, `markBlocked`) in `src/harness/featureList.ts` return a **new** `FeatureList`; the original is never mutated.

### `pickNext`

Selects the next actionable feature:

- Status must be `pending`.
- All `deps` (if any) must be `passing`.
- Sorted by `priority` ascending (numeric, lower = higher priority); features with no `priority` sort after those with one.
- Ties broken by original array order (stable sort).

Returns `null` when no eligible feature exists.

### Stop conditions (in `autonomousRun`)

`allResolved(list)` returns `true` when no feature is `pending` or `in_progress`. `autonomousRun` stops for one of three reasons:

| `stopped` value | Condition |
|---|---|
| `"all_resolved"` | `pickNext()` returned `null` (no more eligible features) |
| `"max_features"` | `opts.maxFeatures` processed |
| `"too_many_blocked"` | consecutive blocked count reached `opts.maxConsecutiveBlocked` (default 2) |

---

## `autonomousRun`: step-by-step

`autonomousRun` in `src/orchestrator/workflows/autonomousRun.ts` is the top-level loop. It accepts:

```ts
interface AutonomousRunOptions {
  readonly runtime: Runtime;
  readonly ledger: Ledger;
  readonly cwd: string;
  readonly featureListPath: string;
  readonly verifyCmd: string;
  readonly maxFeatures?: number;
  readonly maxConsecutiveBlocked?: number;   // default 2
  readonly rollbackOnBlock?: boolean;
  readonly onEvent?: (ev: AutonomousEvent) => void;
}
```

### Per-feature loop

For each feature selected by `pickNext`:

**Step 1 — Mark in-progress and save**

```ts
list = markInProgress(list, feature.id);
await saveFeatureList(opts.featureListPath, list);
opts.onEvent?.({ type: "feature_start", feature });
```

**Step 2 — Checkpoint (if rollback enabled)**

```ts
const cp = opts.rollbackOnBlock ? await checkpoint(opts.cwd) : null;
```

Records the current git HEAD SHA and a stash object for any dirty working-tree state (see [Checkpoint and rollback](#checkpoint-and-rollback)).

**Step 3 — Implement / verify inner loop**

Repeated up to `feature.iterationBudget` (default 3) times:

```ts
for (let attempt = 1; attempt <= iterationBudget; attempt++) {
  await opts.runtime.agent(implementPrompt(feature, opts.verifyCmd, feedback), {
    label: `implement:${feature.id}#${attempt}`,
  });
  verify = await runVerify(opts.verifyCmd, { cwd: opts.cwd });
  if (passed(verify)) break;
  feedback = `Attempt ${attempt} failed (exit ${verify.exitCode}).\nstderr:...`;
}
```

The `implementPrompt` tells the agent which feature to implement, what verify command will be run, and (after the first attempt) the full stderr/stdout from the failed verify run as feedback.

**Step 4 — Objective verify gate**

`runVerify` (`src/harness/verify.ts`) spawns `sh -c <command>` via `Bun.spawn` and captures stdout, stderr, exit code, and elapsed time. It enforces an optional `timeoutMs` by killing the process and setting `timedOut: true`.

`passed(result)` is:

```ts
function passed(result: VerifyResult): boolean {
  return result.exitCode === 0 && !result.timedOut;
}
```

Only a true exit-0 without timeout counts as passing. No other signal is accepted.

**Step 5 — Rubric self-eval gate**

A separate `runtime.agent` call with `schema: rubricSchema`:

```ts
const rubricSchema = z.object({
  verification: z.number().int().min(0).max(2),
  reasoning: z.string(),
});
```

The rubric prompt provides the feature description and the verify command output. The agent is instructed to score `verification` as:

- `2` — fully implemented AND the verify gate passed
- `1` — partial
- `0` — not done

The prompt also includes: "Be strict: never score 2 unless the change is real and complete."

**Step 6 — Passing or blocked**

Both conditions must hold for `passing`:

```ts
if (passed(verify) && rubric?.verification === 2) {
  list = markPassing(list, feature.id);
  consecutiveBlocked = 0;
  await opts.ledger.append("feature", {
    feature: feature.id, status: "passing",
    verifyExit: verify.exitCode, rubric: rubric.verification, gitSha,
  });
} else {
  list = markBlocked(list, feature.id);
  consecutiveBlocked++;
  // optionally rollback...
  await opts.ledger.append("feature", {
    feature: feature.id, status: "blocked",
    verifyExit: verify?.exitCode ?? -1, rubric: rubric?.verification ?? null,
    gitSha, reason,
  });
}
await saveFeatureList(opts.featureListPath, list);
```

After the run, `opts.ledger.verify()` is called and the result is included in `AutonomousRunResult.ledgerOk`.

---

## Objective verify gate (`runVerify` / `passed`)

`runVerify` in `src/harness/verify.ts` is the sole mechanism by which a feature earns `passing`. Its contract:

- Spawns `["sh", "-c", command]` with `Bun.spawn`.
- Merges `process.env` with any `opts.env` overrides.
- Streams stdout and stderr into `Uint8Array[]` arrays concurrently with process exit.
- If `timeoutMs` is set, kills the process after the deadline and sets `timedOut: true`.
- Respects `opts.signal` (external cancellation via `AbortSignal`).
- Returns `VerifyResult`:

```ts
interface VerifyResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}
```

The result is passed to `passed()`. Neither the model's text output nor the rubric alone can make `passed()` return `true`.

---

## Rubric self-eval gate

The rubric is a structured-output agent call. The `rubricPrompt` includes:

- The feature title and description.
- The verify command's exit code.
- Up to 4,000 characters of combined stdout/stderr from the verify run.

The model must call the `structured_output` tool with `{ verification: 0|1|2, reasoning: string }`. Only `verification === 2` (in conjunction with `passed(verify) === true`) advances the feature to `passing`.

The dual-gate design prevents two failure modes:

- A non-zero verify exit alone would not catch an agent that made a passing stub but did not implement the real logic.
- The rubric alone (without the objective gate) could be gamed by a model that scores itself generously.

---

## Checkpoint and rollback

`src/harness/checkpoint.ts` uses git as the snapshot mechanism.

### `checkpoint(cwd)`

1. Checks `git rev-parse --git-dir` — returns `null` if not a git repo.
2. Records HEAD SHA via `git rev-parse HEAD`.
3. Checks `git status --porcelain` for dirtiness.
4. If dirty, runs `git stash create` (writes a stash commit object without touching the working tree or index) and stores the resulting object SHA as `stashRef`.

Returns `Checkpoint | null`:

```ts
interface Checkpoint {
  readonly kind: "git";
  readonly head: string;        // HEAD SHA at checkpoint time
  readonly stashRef: string | null; // stash object SHA, or null if tree was clean
  readonly dirty: boolean;
}
```

### `rollback(cwd, cp)`

1. `git reset --hard <cp.head>` — restores HEAD, index, and working tree to the checkpoint commit. Throws on failure.
2. If `cp.stashRef !== null`, `git stash apply <cp.stashRef>` re-applies the dirty-tree state. Throws on failure (but HEAD is already restored, so the primary goal is achieved either way).

In `autonomousRun`, rollback is best-effort inside a `try/catch` — a failed rollback does not crash the run.

---

## Per-feature signed ledger rows

Every feature outcome is appended to the `Ledger` (see [Orchestrator: HMAC hash-chained ledger](/subsystems/orchestrator#hmac-hash-chained-ledger)):

**Passing row `data`:**
```json
{
  "feature": "feature-id",
  "status": "passing",
  "verifyExit": 0,
  "rubric": 2,
  "gitSha": "abc123..."
}
```

**Blocked row `data`:**
```json
{
  "feature": "feature-id",
  "status": "blocked",
  "verifyExit": 1,
  "rubric": 1,
  "gitSha": "abc123...",
  "reason": "verify exit 1"
}
```

A final `run_end` row is appended after the loop exits:
```json
{ "passing": 3, "blocked": 1, "stopped": "all_resolved" }
```

After appending the `run_end` row, `ledger.verify()` runs a full chain validation. The `ledgerOk` field in `AutonomousRunResult` is `true` if and only if the entire JSONL file's HMAC chain is intact.

---

## `AutonomousEvent` stream

`opts.onEvent` receives typed events for external progress reporting:

| `type` | Key fields |
|---|---|
| `feature_start` | `feature: Feature` |
| `attempt` | `featureId`, `attempt` |
| `verify` | `featureId`, `attempt`, `exitCode`, `passed` |
| `feature_passing` | `featureId` |
| `feature_blocked` | `featureId`, `reason` |
| `run_end` | `passing`, `blocked`, `stopped` |

---

## `AutonomousRunResult`

```ts
interface AutonomousRunResult {
  readonly passing: number;
  readonly blocked: number;
  readonly stopped: "all_resolved" | "max_features" | "too_many_blocked";
  readonly ledgerOk: boolean;
}
```

---

## See also

- [Orchestrator](/subsystems/orchestrator) — `Runtime`, `Ledger`, and the concurrency semaphore the harness uses
- [Agent Loop](/subsystems/agent-loop) — `runQuery` powers the implement and rubric agents
- ADR 0001 §5.3 / §7.7 — full design rationale for the state machine and verify gate
