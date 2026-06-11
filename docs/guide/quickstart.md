# Quickstart

Three first runs, end-to-end, with expected output shapes. Each builds on the previous one. (In a hurry? [Run 0](#offline-demo) needs no API key.)

---

## Run 0 — Try it offline, no API key {#offline-demo}

A scripted model (`ALFRED_MOCK_SCRIPTS`) drives the **real** harness end to
end — engine, `file_write` tool, permission stack, `bun test` verify gate,
rubric gate, signed ledger. Zero API calls:

```bash
git clone https://github.com/BeamusWayne/Alfred && cd Alfred && bun install
bun run demo          # implement → verify gate exit 0 → rubric 2/2 → signed ledger
bun run demo:verify   # ✓ ledger intact — 2 rows, hash chain + head anchor verified
```

Then try to cheat:

```bash
cd examples/demo
sed -i '' 's/"passing"/"PASSING"/' .alfred/workflows/*/ledger.jsonl   # flip ONE byte
bun ../../src/index.ts ledger verify
# ✗ TAMPER DETECTED at row 0: Signature mismatch at seq 0   (exit 1)
```

The point in one line: **"done" is a captured exit code plus a receipt you can
re-verify — not the model's claim.** [`examples/demo/README.md`](https://github.com/BeamusWayne/Alfred/tree/main/examples/demo)
explains each step; the home page [replays this exact session](../index.md#watch).

---

## Before you start

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

All three examples assume `alfred` is on your PATH via `bun link`. If not, replace every `alfred` with `bun run src/index.ts`.

---

## Run 1 — One-shot query (`alfred -p "…"`)

One-shot mode sends a prompt, runs the agent loop, and exits. Text goes to stdout; tool traces and cost go to stderr. The `-p` flag is "print mode" — non-interactive, no REPL.

```bash
alfred -p "explain what this repo does in three sentences"
```

**What happens under the hood:**
1. `src/index.ts` calls `loadConfig()`, builds the system prompt from `src/context/index.ts`, and starts `runQuery()` in `src/query/engine.ts`.
2. `runQuery` is an async generator. It sends the message to the provider, yields `text` events as the response streams in, and yields `done` when the model stops requesting tools.
3. The CLI renders each event: text → stdout, tool calls → dim stderr, cost → dim stderr.

**Expected output shape:**

```
Alfred is a verifiable autonomous coding agent CLI built with TypeScript on Bun.
It provides a machine-enforced autonomy harness that drives a feature list to
completion under an objective verify gate, leaving a signed run receipt.

↻ (no tool calls for a simple explain prompt)
[success]
[cost: $0.0021]
```

The exact text varies by model. The structure is fixed: text on stdout, status and cost on stderr. Pipe to `cat` for a clean answer:

```bash
alfred -p "list the src/ subdirectories" | cat
```

### Flags for one-shot mode

| Flag | Effect |
|---|---|
| `-p`, `--print` | Non-interactive (print mode). |
| `-m`, `--model <model>` | Override the model for this run. |
| `--permission-mode <mode>` | `default`, `acceptEdits`, `plan`, or `bypass`. |
| `--max-turns <n>` | Stop after N agent turns (default 50). |
| `--yes` | Auto-approve all tool calls that would otherwise prompt. |

---

## Run 2 — Autonomous harness (`alfred run`)

`alfred run` is the flagship: it reads a `feature_list.json`, picks features in priority order, and drives each one through an implement → verify → rubric loop. A feature is marked `passing` only when the verify command exits 0 **and** the rubric self-eval scores 2/2. Every step is written to a signed, HMAC hash-chained ledger.

### Set up a feature list

Use the included example, or copy it to your project root:

```bash
cp feature_list.example.json feature_list.json
```

`feature_list.example.json` contains two small string-utility features with explicit `iterationBudget`, `priority`, and `deps` fields.

### Run with a verify command

```bash
ALFRED_LEDGER_SECRET=$(openssl rand -hex 32) \
  alfred run --verify "bun test" --max-features 2
```

::: warning Set ALFRED_LEDGER_SECRET in production
If `ALFRED_LEDGER_SECRET` is not set, Alfred uses a hard-coded insecure default. The ledger will still chain correctly, but anyone who knows the default secret can forge a valid signature. Always generate a real secret for unattended runs.
:::

**What happens under the hood:**
1. `src/index.ts` creates a `Journal` and a `Ledger`, then calls `autonomousRun()` in `src/orchestrator/workflows/autonomousRun.ts`.
2. The harness picks the first pending feature, calls `runtime.agent(implementPrompt(feature, verifyCmd, feedback))` to implement it, then calls `runVerify("bun test", { cwd })` and inspects `exitCode`.
3. If the exit code is non-zero and attempts remain, the harness feeds the stderr back as `feedback` and retries (up to `iterationBudget` times, default 3).
4. Once verify passes (or the budget is exhausted), a rubric agent receives the feature spec and verify output and responds with `{ verification: 0|1|2, reasoning: "…" }`. Only `verification === 2` AND `exitCode === 0` marks the feature `passing`.
5. The harness appends a signed ledger row and emits a `feature_passing` or `feature_blocked` NDJSON event to stdout.

**Expected output (NDJSON to stdout, traces to stderr):**

```
{"type":"feature_start","feature":{"id":"slugify","title":"Add a slugify utility",...}}
{"type":"attempt","featureId":"slugify","attempt":1}
{"type":"verify","featureId":"slugify","attempt":1,"exitCode":0,"passed":true}
{"type":"feature_passing","featureId":"slugify"}
{"type":"attempt","featureId":"truncate","attempt":1}
{"type":"verify","featureId":"truncate","attempt":1,"exitCode":1,"passed":false}
{"type":"attempt","featureId":"truncate","attempt":2}
{"type":"verify","featureId":"truncate","attempt":2,"exitCode":0,"passed":true}
{"type":"feature_passing","featureId":"truncate"}
{"type":"run_end","passing":2,"blocked":0,"stopped":"all_resolved"}
```

Stderr from the harness (dim, informational):

```
  [run 2026-06-06T10-00-00-000Z] feature_list=./feature_list.json verify="bun test"
  ⚙ implement:slugify#1 …
  ↻ retry 1 in 1000ms (overloaded)          ← only if a transient error occurs
  [run 2026-06-06T10-00-00-000Z] passing=2 blocked=0 stopped=all_resolved ledger=ok
```

### Ledger and journal files

After the run, inspect the artifacts:

```bash
cat .alfred/workflows/*/ledger.jsonl | jq .
cat .alfred/workflows/*/journal.jsonl | jq .
```

Each ledger entry has the shape:

```json
{
  "seq": 0,
  "kind": "feature",
  "ts": 1749200000000,
  "data": {
    "feature": "slugify",
    "status": "passing",
    "verifyExit": 0,
    "rubric": 2,
    "gitSha": "abc1234"
  },
  "prevSig": "0000000000000000000000000000000000000000000000000000000000000000",
  "sig": "3f8a…"
}
```

`ledger=ok` in the summary means `Ledger.verify()` confirmed every entry's signature and chain link are intact.

### Additional `alfred run` flags

| Flag | Effect |
|---|---|
| `--feature-list <path>` | Path to `feature_list.json` (default: `./feature_list.json`). |
| `--verify <cmd>` | Verify command (default: `$ALFRED_VERIFY_CMD` or `bun test`). |
| `--max-features <n>` | Stop after processing N features. |
| `--rollback-on-block` | Git-rollback the working tree when a feature is blocked. |
| `--budget-usd <n>` | Stop when estimated API spend exceeds this amount. |

---

## Run 3 — Eval replay (`alfred eval <file>`)

`alfred eval` replays recorded `MockProvider` trajectories through the real engine and asserts no regressions. It exits non-zero if any case fails — suitable for CI.

### Run the existing eval suite

Alfred's own test suite includes eval cases. To run them directly:

```bash
alfred eval ./tests/eval/cases.ts
```

If the file does not exist yet in your project, you can write your own. An eval case file exports an array of `EvalCase` objects (from `src/eval/types.ts`):

```ts
import type { EvalCase } from "./src/eval/types.ts";

export default [
  {
    name: "simple text response",
    prompt: "say hello",
    provider: {
      // Scripted model responses — no API key needed
      responses: [
        { content: [{ type: "text", text: "Hello!" }], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 }, model: "mock" }
      ]
    },
    assert: {
      status: "success",
      textContains: "Hello"
    }
  }
] satisfies EvalCase[];
```

**Expected output:**

```
PASS  simple text response
────────────────────────────
1 passed  0 failed
```

A failed case:

```
FAIL  simple text response
  Expected status "success", got "provider_error"
────────────────────────────
0 passed  1 failed
```

`alfred eval` exits 0 if all cases pass, 1 if any fail. Use it as a CI gate alongside `bun test`.

---

## What all three runs share

| Concern | Behavior |
|---|---|
| **Text output** | Always goes to stdout — safe to pipe. |
| **Traces, tool calls, cost** | Always go to stderr — safe to suppress with `2>/dev/null`. |
| **Cost line** | Printed to stderr as `[cost: $X.XXXX]` when spend exceeds zero. |
| **Exit code** | 0 = success / all resolved; 1 = error or blocked features. |
| **Abort** | Ctrl-C sends SIGINT; the agent loop honors the AbortSignal and exits cleanly. |
