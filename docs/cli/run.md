# alfred run — autonomous harness

`alfred run` drives a `feature_list.json` file to green autonomously. For each
pending feature it runs an implement agent, verifies with a configurable shell
command, applies a rubric self-evaluation, signs a hash-chained ledger row, and
continues until all features resolve or a stop condition is met.

```bash
alfred run
alfred run --feature-list feature_list.json --verify "bun test" --budget-usd 2.00
```

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-m, --model <model>` | string | `ALFRED_MODEL` or `claude-sonnet-4-6` | Model id for the implement and rubric agents |
| `--feature-list <path>` | path | `./feature_list.json` | Path to the feature list JSON file |
| `--verify <cmd>` | shell command | `$ALFRED_VERIFY_CMD` or `bun test` | Command whose exit code is the objective pass/fail gate |
| `--max-features <n>` | integer | unlimited | Stop after processing N features |
| `--rollback-on-block` | boolean | false | `git` rollback the working tree when a feature is blocked |
| `--budget-usd <n>` | float | unlimited | Stop when estimated spend exceeds this USD budget |

## Run lifecycle

```
for each pending feature in feature_list.json:
  1. Pick next pending feature (priority order).
  2. Mark it "in_progress"; save the file.
  3. Emit feature_start event.
  4. Optional: git checkpoint (when --rollback-on-block).
  5. Inner verify-fix loop (up to feature.iterationBudget attempts, default 3):
     a. Emit attempt event.
     b. Run implement agent (real tools: read, write, bash, edit, glob, grep…).
     c. Run verify command; emit verify event.
     d. Break if verify exit == 0.
     e. Feed stderr/stdout back to implement agent as feedback.
  6. Run rubric self-eval agent — scores 0/1/2 for completeness.
  7. Feature passes only when: verify exit == 0 AND rubric score == 2.
  8. Append signed, hash-chained row to ledger.jsonl.
  9. Emit feature_passing or feature_blocked event.
  10. On block: optionally rollback; bump consecutive-blocked counter.

Stop conditions (any stops the loop):
  - all_resolved   — no more pending features
  - max_features   — --max-features limit hit
  - too_many_blocked — 2 consecutive blocks (hardcoded)
```

Autonomous mode always runs with `permission-mode bypass` internally (to avoid
interactive prompts), but the bash kill-list and path jail still apply — see
[Permissions](/config/permissions).

## NDJSON event stream

Every event is a JSON object emitted as a single line to **stdout**. This makes
`alfred run | jq` work cleanly. The stream is also suitable for
machine-readable CI integrations.

### `feature_start`

Emitted when a feature is picked and work begins.

```json
{
  "type": "feature_start",
  "feature": {
    "id": "slugify",
    "title": "Add a slugify utility",
    "description": "Create src/strings/slugify.ts…",
    "status": "in_progress",
    "priority": 1,
    "iterationBudget": 3
  }
}
```

### `attempt`

Emitted at the start of each implement-agent attempt within the inner loop.

```json
{ "type": "attempt", "featureId": "slugify", "attempt": 1 }
```

`attempt` is 1-based; maximum value equals `feature.iterationBudget`.

### `verify`

Emitted after the verify command returns for each attempt.

```json
{
  "type": "verify",
  "featureId": "slugify",
  "attempt": 1,
  "exitCode": 1,
  "passed": false
}
```

`passed` is `true` when `exitCode === 0`.

### `feature_passing`

Emitted when a feature passes both the verify gate (exit 0) and the rubric
(score 2). The ledger row is appended before this event fires.

```json
{ "type": "feature_passing", "featureId": "slugify" }
```

### `feature_blocked`

Emitted when a feature exhausts its iteration budget without passing. Includes
the blocking reason.

```json
{
  "type": "feature_blocked",
  "featureId": "truncate",
  "reason": "verify exit 1"
}
```

`reason` is either `verify exit <code>` (verify failed) or
`rubric <score>` (rubric scored below 2 despite verify passing).

### `run_end`

The final event. Always emitted, even when the run is aborted via Ctrl-C after
the loop exits normally.

```json
{
  "type": "run_end",
  "passing": 1,
  "blocked": 1,
  "stopped": "all_resolved"
}
```

`stopped` values:

| Value | Meaning |
|-------|---------|
| `"all_resolved"` | No more pending features — clean finish |
| `"max_features"` | `--max-features` limit was reached |
| `"too_many_blocked"` | 2 consecutive features blocked (hardcoded threshold) |

## stderr summary line

After the event loop completes, a single summary line is written to **stderr**:

```
[run 2026-06-06T12-00-00-000Z] passing=2 blocked=0 stopped=all_resolved ledger=ok
```

`ledger=ok` means all ledger rows pass HMAC verification. `ledger=TAMPERED`
means at least one row was altered, reordered, or truncated.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | `stopped === "all_resolved"` and `blocked === 0` |
| `1` | Any blocked features, or stopped before all resolved |

## Artifacts under `.alfred/workflows/<runId>/`

Each run writes two append-only JSONL files:

| File | Description |
|------|-------------|
| `journal.jsonl` | Every completed step, with monotonic `seq`, `type`, optional `key`, optional `label`, `data`, and `ts` (Unix ms). Used for resume/replay. |
| `ledger.jsonl` | HMAC-SHA-256 signed, hash-chained rows. Each row records feature outcome (`status`, `verifyExit`, `rubric`, `gitSha`) or the final `run_end` summary. Tamper-evident: any edit breaks the chain. |

The `runId` is the ISO-8601 timestamp of when the run started, with colons and
dots replaced by hyphens (e.g. `2026-06-06T12-00-00-000Z`).

### Ledger row shape

```json
{
  "seq": 0,
  "kind": "feature",
  "ts": 1749211200000,
  "data": {
    "feature": "slugify",
    "status": "passing",
    "verifyExit": 0,
    "rubric": 2,
    "gitSha": "a1b2c3d"
  },
  "prevSig": "0000…0000",
  "sig": "e3f9…ab12"
}
```

The `sig` is HMAC-SHA-256 over the canonical (sorted-key) JSON of the payload
concatenated with `prevSig`, keyed by `ALFRED_LEDGER_SECRET`.

## Examples

```bash
# Default run — uses ./feature_list.json and bun test
alfred run

# Stream events through jq to watch progress
alfred run | jq -r 'select(.type == "feature_passing") | .featureId'

# Cap spend to $1 and roll back failed features
alfred run --budget-usd 1.00 --rollback-on-block

# Use a custom test command and limit to 5 features
alfred run --verify "pytest -x" --max-features 5
```

::: tip Ledger verification
After a run, verify the ledger has not been tampered with:

```bash
# The summary already reports ledger=ok|TAMPERED
# The raw file lives at:
cat .alfred/workflows/<runId>/ledger.jsonl | jq '.'
```
:::

::: warning Ctrl-C handling
Alfred installs a `SIGINT` handler that aborts the current agent turn cleanly.
The ledger is always finalized (a `run_end` row is appended) before the process
exits.
:::
