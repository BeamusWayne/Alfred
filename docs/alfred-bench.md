# Alfred-Bench — the self-rebuild demo (Phase 4)

**English** | Status: scaffolded

Alfred-Bench is the flagship demonstration of the whole thesis: *verifiable autonomy you can't fake.* Alfred rebuilds a working module **from an empty `src/`** under a verification gate it does not control, producing a **signed, replayable receipt** of the run.

## Why it's an honest benchmark

Three properties make it impossible to game (ADR 0001 §7.7):

1. **Held-out verification.** The model never runs the gate. `alfred run` runs `VERIFY_CMD` (e.g. `bun test`) itself and trusts only the exit code — a feature is marked `passing` only on a captured exit 0 **and** a rubric self-eval of 2.
2. **Dual pass-condition** (SWE-bench Verified style). The verify suite must go FAIL → PASS as the feature is built; pre-existing-passing tests must stay PASS. The rubric gate guards against "tests pass but the feature isn't really there."
3. **Signed ledger.** Every feature outcome is an HMAC hash-chained row in `.alfred/workflows/<runId>/ledger.jsonl`. Tampering, reordering, or truncation is detectable (`Ledger.verify()`), so the run is auditable after the fact. The journal (`journal.jsonl`) makes it replayable.

## Running it

```bash
# 1. A feature_list.json describes the target (see feature_list.example.json).
cp feature_list.example.json feature_list.json

# 2. Provide the held-out verification command + a ledger secret.
export ANTHROPIC_API_KEY=sk-ant-...
export ALFRED_LEDGER_SECRET=$(openssl rand -hex 32)

# 3. Let the harness drive it to green. The model writes code with real tools;
#    the harness alone runs the gate and signs each outcome.
bun run src/index.ts run --verify "bun test" --max-features 10

# 4. Audit the receipt.
cat .alfred/workflows/*/ledger.jsonl     # signed, hash-chained feature outcomes
cat .alfred/workflows/*/journal.jsonl    # replayable agent trajectory
```

`alfred run` emits NDJSON events on stdout (`feature_start`, `verify`, `feature_passing`, `feature_blocked`, `run_end`) and a summary on stderr, including `ledger=ok|TAMPERED`.

## The moonshot variant

The full Alfred-Bench withholds the test files from the model entirely (they live outside the worktree and are mounted only by the harness at verify time), so the agent cannot read the gate it must satisfy. With best-of-N (`src/orchestrator/workflows/bestOfN.ts`) wrapping the implement step under worktree isolation, the harness can sample N trajectories and keep the first whose `VERIFY_CMD` exits 0 — inference-time scaling with an objective reward, no trained critic required.

This is the literal realization of the README's claim: **"watch it rebuild itself under a gate it can't cheat."**
