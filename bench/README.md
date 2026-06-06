# Alfred-Bench — Phase 4 Demo

Alfred-Bench is the flagship demonstration of verifiable autonomy: the model rebuilds a working module from an empty `src/` under a verification gate it cannot see or edit, producing a signed, replayable receipt.

## Prerequisites

- Bun >= 1.3.0
- `ANTHROPIC_API_KEY` set in your environment
- A ledger secret (generate once and keep it safe):
  ```bash
  export ALFRED_LEDGER_SECRET=$(openssl rand -hex 32)
  ```

## Running Alfred-Bench

```bash
bun run src/bench/cli.ts <spec.json>
```

A `BenchSpec` JSON file has the following shape:

```json
{
  "targetDir":       "/path/to/empty/workspace",
  "heldOutTestsDir": "/path/to/held-out-tests",
  "featureListPath": "/path/to/feature_list.json",
  "testCmd":         "bun test"
}
```

| Field              | Description                                                                     |
|--------------------|---------------------------------------------------------------------------------|
| `targetDir`        | Directory the model works in. Must not contain the held-out test files.         |
| `heldOutTestsDir`  | Directory holding the test files the model must satisfy but cannot read.        |
| `featureListPath`  | `feature_list.json` listing the features to implement (see `feature_list.example.json`). |
| `testCmd`          | Shell command run to exercise the suite (e.g. `bun test`).                     |

### Full workflow

```bash
# 1. Prepare a clean target directory (the model's workspace).
mkdir -p /tmp/alfred-bench-target

# 2. Place held-out tests in a separate directory (never shown to the model).
mkdir -p /tmp/alfred-bench-held-out
cp tests/slugify.test.ts /tmp/alfred-bench-held-out/

# 3. Write a BenchSpec.
cat > bench/my-run.json <<EOF
{
  "targetDir":       "/tmp/alfred-bench-target",
  "heldOutTestsDir": "/tmp/alfred-bench-held-out",
  "featureListPath": "feature_list.json",
  "testCmd":         "bun test"
}
EOF

# 4. Set secrets and run.
export ANTHROPIC_API_KEY=sk-ant-...
export ALFRED_LEDGER_SECRET=$(openssl rand -hex 32)

bun run src/bench/cli.ts bench/my-run.json
```

The CLI emits a JSON result line on stdout and a human-readable summary on stderr:

```
{"type":"bench_result","features":2,"passing":2,"dualPassConfirmed":2,"ledgerOk":true}

[alfred-bench] features=2 passing=2 dualPassConfirmed=2 ledger=ok
```

Exit code is `0` only when every feature dual-passed and the ledger is intact.

## The held-out invariant

The central guarantee that makes Alfred-Bench impossible to game:

1. **Before each model turn** — the held-out test files do NOT exist in `targetDir`. The model cannot read, inspect, or reverse-engineer them.
2. **At verify time** (called by the harness, outside the model's turns) — `runHeldOutVerify` copies the held-out files into `targetDir`, runs `testCmd`, captures the exit code, then **immediately removes** the files.
3. **Dual pass-condition** — a feature is only counted as `dualPassConfirmed` when the suite goes **FAIL → PASS**: it must have failed before the model's turn (confirming the feature was not pre-built) and passed after (confirming the model's implementation satisfies the gate).

This is enforced in `src/bench/alfredBench.ts` by `runHeldOutVerify`, which wraps `runVerify` from `src/harness/verify.ts`.

## Reading the signed ledger

After a run, the ledger lives at:

```
<targetDir>/.alfred/workflows/<runId>/ledger.jsonl
```

Each line is a JSON object with fields `seq`, `kind`, `ts`, `data`, `prevSig`, and `sig`. The HMAC-SHA256 chain means any edit, reorder, or truncation is detectable.

To audit programmatically:

```typescript
import { Ledger } from "./src/orchestrator/ledger.ts";
const ledger = new Ledger(path, process.env.ALFRED_LEDGER_SECRET!);
const result = await ledger.verify();
console.log(result); // { ok: true } or { ok: false, brokenAt: N, reason: "..." }
```

The `dual_pass_check` entries record the `preFail` / `postPass` / `dualPass` outcome for every feature, providing a per-feature audit trail.

## What needs a real model vs. what is unit-tested

| Aspect                              | Covered by unit tests | Needs a real model |
|-------------------------------------|-----------------------|--------------------|
| Held-out tests absent before/after  | Yes (`alfredBench.test.ts`) | No |
| `runHeldOutVerify` exit code        | Yes                   | No |
| FAIL→PASS dual condition            | Yes (stub runtime)    | No |
| Ledger signing / verification       | Yes (via `ledger.test.ts`) | No |
| Model actually writes correct code  | No                    | Yes |
| End-to-end `cli.ts` invocation      | No                    | Yes |
