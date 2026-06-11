# Offline demo — the harness with a scripted model

Watch `alfred run` drive a feature to green **without an API key**: the model
responses come from [`scripts.ts`](./scripts.ts) (the same record/replay
mechanism `alfred eval` uses), while everything else is real — the engine, the
`file_write` tool, the permission stack, the `bun test` verify gate, the rubric
gate, and the HMAC-signed ledger.

```bash
# from the repo root
bun run demo          # reset + autonomous run: implement → verify → rubric → signed ledger
bun run demo:verify   # ✓ ledger intact — 2 rows, hash chain + head anchor verified
```

Now try to cheat:

```bash
cd examples/demo
sed -i '' 's/"passing"/"PASSING"/' .alfred/workflows/*/ledger.jsonl   # flip ONE byte
bun ../../src/index.ts ledger verify
# ✗ TAMPER DETECTED at row 0: Signature mismatch at seq 0   (exit 1)
```

## What just happened

1. `feature_list.json` holds one pending feature: *implement `add()` so
   `add.test.ts` passes*.
2. The (scripted) implement agent writes `add.ts` through the real
   `file_write` tool — path-jailed to this directory.
3. The **verify gate** runs `bun test add.test.ts` for real and trusts only
   its exit code; the (scripted) rubric judge then scores 2/2.
4. The harness appends a signed, hash-chained row to
   `.alfred/workflows/<runId>/ledger.jsonl` — the Proof Receipt.
5. `alfred ledger verify` recomputes the chain; any edit, reorder or
   truncation fails with exit 1.

The point: **"done" is the gate's exit code and a receipt you can re-verify —
not the model's claim.** A scripted model that *lies* here changes nothing;
it cannot fake `bun test` exiting 0, and it cannot forge the HMAC chain.

`./reset.sh` returns the demo to its starting state.
