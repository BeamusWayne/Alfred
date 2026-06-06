# Running an Autonomous Build (Alfred-Bench)

Alfred's autonomous harness drives a `feature_list.json` to green under a
verification gate it does not control. Every feature outcome is recorded in a
signed, hash-chained ledger, giving you a tamper-evident receipt of the entire
run.

This guide walks through writing a feature list, launching `alfred run`,
reading the NDJSON event stream, and auditing the signed ledger.

## Prerequisites

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export ALFRED_LEDGER_SECRET=$(openssl rand -hex 32)
```

`ALFRED_LEDGER_SECRET` is the HMAC key that signs every ledger row. Keep it
constant for a run; rotate it between projects or CI environments.

## Step 1 — Write a `feature_list.json`

Every run needs a feature list that describes the units of work Alfred must
implement. Copy the bundled example and edit it for your project:

```bash
cp feature_list.example.json feature_list.json
```

### Schema reference

```json
{
  "features": [
    {
      "id":              "slugify",
      "title":           "Add a slugify utility",
      "description":     "Create src/strings/slugify.ts …",
      "status":          "pending",
      "priority":        1,
      "iterationBudget": 3,
      "deps":            []
    }
  ]
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | `string` (min 1 char) | yes | Unique stable key; used in ledger rows and dep references |
| `title` | `string` (min 1 char) | yes | Short human label shown in progress output |
| `description` | `string` | yes | Full task prompt sent verbatim to the implement agent |
| `status` | `"pending" \| "in_progress" \| "passing" \| "blocked"` | yes | Start every feature at `"pending"` |
| `priority` | `number` | no | Lower value runs first; features without a priority sort after all numbered features |
| `iterationBudget` | `integer >= 1` | no | Maximum implement → verify cycles per feature; defaults to **3** |
| `deps` | `string[]` | no | Feature `id`s that must be `"passing"` before this feature becomes eligible |

**Scheduling rules** (from `src/harness/featureList.ts`):

- The harness picks one feature at a time via `pickNext()`.
- A feature is eligible when its `status === "pending"` and every `deps` entry
  is `"passing"`.
- Among eligible features, the lowest `priority` number wins; ties preserve
  original array order.

### Complete example with dependencies

```json
{
  "features": [
    {
      "id": "slugify",
      "title": "Add a slugify utility",
      "description": "Create src/strings/slugify.ts exporting `slugify(s: string): string` that lowercases, trims, replaces runs of non-alphanumeric characters with single hyphens, and strips leading/trailing hyphens. Add tests/slugify.test.ts covering: basic phrase, leading/trailing punctuation, unicode/space collapsing, and the empty string.",
      "status": "pending",
      "priority": 1,
      "iterationBudget": 3
    },
    {
      "id": "truncate",
      "title": "Add a truncate utility",
      "description": "Create src/strings/truncate.ts exporting `truncate(s: string, max: number): string` that returns s unchanged when it fits, else cuts to `max` characters total INCLUDING a trailing ellipsis '…'. Add tests/truncate.test.ts covering: short string unchanged, exact-length boundary, long string truncated with ellipsis, and max smaller than the ellipsis.",
      "status": "pending",
      "priority": 2,
      "iterationBudget": 3,
      "deps": ["slugify"]
    }
  ]
}
```

`truncate` will not start until `slugify` is `passing`.

## Step 2 — Choose a verify command

The verify command is the **objective gate**: Alfred runs it after each
implement attempt and trusts only its exit code. The model never runs this
command; only the harness does.

```bash
# Default (no flag needed)
bun test

# Explicit override
alfred run --verify "bun test --coverage"

# Multiple checks chained
alfred run --verify "bun typecheck && bun test"

# Persistent env variable
export ALFRED_VERIFY_CMD="bun test"
alfred run
```

Priority: `--verify` flag > `ALFRED_VERIFY_CMD` env > default `bun test`.

## Step 3 — Launch the autonomous run

```bash
alfred run \
  --verify "bun test" \
  --feature-list feature_list.json \
  --max-features 10 \
  --budget-usd 2.00
```

All flags are optional:

| Flag | Default | Description |
|---|---|---|
| `--feature-list <path>` | `./feature_list.json` | Path to the feature list |
| `--verify <cmd>` | `bun test` | Objective gate command |
| `--max-features <n>` | unlimited | Stop after N features regardless of status |
| `--rollback-on-block` | off | `git checkout` the working tree when a feature is blocked |
| `--budget-usd <n>` | unlimited | Stop when estimated spend exceeds this USD threshold |
| `-m, --model <id>` | `claude-sonnet-4-6` | Override the default model |

### What happens under the hood

For each feature the harness:

1. Calls `pickNext()` — selects the next eligible `pending` feature.
2. Marks it `in_progress` and saves `feature_list.json`.
3. Runs an **implement agent** (up to `iterationBudget` attempts). After each
   attempt the harness runs `VERIFY_CMD` and feeds exit-code + stderr back as
   feedback for the next attempt.
4. Runs a **rubric agent** that produces
   `{ verification: 0 | 1 | 2, reasoning: string }`. Score 2 means "fully
   implemented and the verify gate passed."
5. A feature is marked `passing` **only when both** verify exit == 0 **and**
   rubric == 2. Either condition alone is insufficient.
6. On block, optionally rolls back via git.
7. Appends a signed row to the ledger and updates `feature_list.json`.

The harness stops when one of:
- `all_resolved` — every feature is `passing` or `blocked`
- `max_features` — the `--max-features` limit was reached
- `too_many_blocked` — two or more consecutive features were blocked (default
  threshold: 2 consecutive)

## Step 4 — Read the NDJSON event stream

`alfred run` emits one JSON object per line to **stdout** for each lifecycle
event. Pipe it for real-time progress:

```bash
alfred run --verify "bun test" | jq .
```

### Event shapes

```ts
// Feature selected and starting
{ "type": "feature_start",   "feature": { "id": "slugify", "title": "…", … } }

// Implement attempt began
{ "type": "attempt",         "featureId": "slugify", "attempt": 1 }

// Verify gate ran
{ "type": "verify",          "featureId": "slugify", "attempt": 1,
                               "exitCode": 0, "passed": true }

// Feature passed both gates
{ "type": "feature_passing", "featureId": "slugify" }

// Feature exhausted its budget or hit too many blocks
{ "type": "feature_blocked", "featureId": "truncate", "reason": "verify exit 1" }

// Run complete
{ "type": "run_end",         "passing": 1, "blocked": 1,
                               "stopped": "all_resolved" }
```

`stopped` is one of `"all_resolved"`, `"max_features"`, or
`"too_many_blocked"`.

### Capturing a structured log

```bash
alfred run --verify "bun test" | tee run-events.ndjson | jq -r \
  'select(.type == "feature_passing" or .type == "feature_blocked") |
   "\(.type)  \(.featureId)"'
```

A summary line is also written to **stderr** (not captured by pipes):

```
[run 2026-06-06T12-00-00-000Z] passing=1 blocked=0 stopped=all_resolved ledger=ok
```

`ledger=TAMPERED` means the chain failed verification — see step 5.

## Step 5 — Audit the signed ledger

Every run writes two files under `.alfred/workflows/<runId>/`:

| File | Purpose |
|---|---|
| `ledger.jsonl` | Signed, hash-chained feature outcomes |
| `journal.jsonl` | Full agent trajectory — replayable step tape |

### Ledger row anatomy

```jsonc
{
  "seq":     0,
  "kind":    "feature",
  "ts":      1749208800000,
  "data": {
    "feature":   "slugify",
    "status":    "passing",
    "verifyExit": 0,
    "rubric":    2,
    "gitSha":    "a1b2c3d4…"
  },
  "prevSig": "0000000000000000000000000000000000000000000000000000000000000000",
  "sig":     "3f8a…"
}
```

- `seq` — zero-based row index; must equal array position.
- `prevSig` — the `sig` of the preceding row, or 64 zeros for seq 0 (genesis
  anchor).
- `sig` — HMAC-SHA256 over the canonical JSON of `{data, kind, seq, ts}` +
  `prevSig`, keyed by `ALFRED_LEDGER_SECRET`.
- Any edit, reorder, or truncation of rows breaks the chain.

The final row has `kind: "run_end"` with `{ passing, blocked, stopped }`.

### Inspect the ledger

```bash
# Pretty-print all rows
cat .alfred/workflows/*/ledger.jsonl | jq .

# Show only passing features
cat .alfred/workflows/*/ledger.jsonl | jq 'select(.data.status == "passing")'

# Show the git SHA at which each feature was accepted
cat .alfred/workflows/*/ledger.jsonl | jq -r \
  'select(.kind == "feature" and .data.status == "passing") |
   "\(.data.feature)  \(.data.gitSha)"'
```

### Verify the chain integrity

```ts
// scripts/audit-ledger.ts
import { Ledger } from "./src/orchestrator/ledger.ts";

const secret = process.env.ALFRED_LEDGER_SECRET ?? "";
const runId  = process.argv[2] ?? "";
const ledger = new Ledger(`.alfred/workflows/${runId}/ledger.jsonl`, secret);

const result = await ledger.verify();
if (result.ok) {
  console.log("Ledger intact.");
} else {
  console.error(`TAMPERED at seq ${result.brokenAt}: ${result.reason}`);
  process.exit(1);
}
```

```bash
bun run scripts/audit-ledger.ts 2026-06-06T12-00-00-000Z
```

### Replay via the journal

```bash
# Read the full agent trajectory in chronological order
cat .alfred/workflows/*/journal.jsonl | jq .
```

Each journal row records a completed workflow step with its seq, type, optional
key, label, data payload, and timestamp. The `findByKey` mechanism lets a
resumed run skip steps whose results are already recorded.

::: tip Ledger secrets and CI
Set `ALFRED_LEDGER_SECRET` as a CI secret and pass the same value to your audit
script. Without the correct secret `Ledger.verify()` will report `TAMPERED`
even on an unmodified file.
:::

::: warning Default secret
When `ALFRED_LEDGER_SECRET` is unset Alfred uses
`alfred-dev-insecure-secret-change-me`. Never rely on this in production;
anyone who knows the default secret can forge a valid chain.
:::
