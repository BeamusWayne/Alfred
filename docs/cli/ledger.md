# alfred ledger — verify Proof Receipts

Every `alfred run` leaves a signed, hash-chained ledger (the **Proof Receipt**,
ADR 0001 §5.3 + ADR 0004) under `.alfred/workflows/<runId>/ledger.jsonl`.
`alfred ledger verify` recomputes the whole chain and exits non-zero on the
first broken row — one command to answer *"is this receipt genuine?"*

```bash
alfred ledger verify          # verify the latest run under .alfred/workflows
alfred ledger verify <path>   # verify a specific ledger.jsonl
```

## What is checked

| Check | Catches |
|-------|---------|
| HMAC-SHA-256 signature per row (`ALFRED_LEDGER_SECRET`) | Any edit to a row's payload |
| `prevSig` hash chain | Reordered, inserted or deleted rows |
| `seq` continuity | Dropped rows mid-chain |
| Signed head anchor (`ledger.jsonl.head`) | **Tail truncation** — a prefix of a valid chain is itself valid, so the chain alone cannot catch it; the anchor signs `(count, lastSig)` |

Rows are redacted before signing (ADR 0003), so a receipt is safe to share —
verification never requires the secrets that appeared in tool output.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Chain + head anchor verified |
| 1 | Tamper detected, or no ledger found |

## Example session

```bash
$ alfred ledger verify
✓ ledger intact — 2 rows, hash chain + head anchor verified
  .alfred/workflows/2026-06-11T02-57-18-825Z/ledger.jsonl

$ sed -i '' 's/"passing"/"PASSING"/' .alfred/workflows/*/ledger.jsonl   # flip one byte

$ alfred ledger verify
✗ TAMPER DETECTED at row 0: Signature mismatch at seq 0
  .alfred/workflows/2026-06-11T02-57-18-825Z/ledger.jsonl
$ echo $?
1
```

## CI usage

Gate a pipeline on receipt integrity after an autonomous run:

```yaml
- run: alfred run --verify "bun test" --max-features 5
  env:
    ALFRED_LEDGER_SECRET: ${{ secrets.ALFRED_LEDGER_SECRET }}
- run: alfred ledger verify
  env:
    ALFRED_LEDGER_SECRET: ${{ secrets.ALFRED_LEDGER_SECRET }}
```

The same secret must be supplied at verify time — signatures are HMAC, not
public-key: whoever holds the secret can both sign and verify. Keep it in your
CI secret store, not in the repo.

## See also

- [alfred run](./run.md) — the harness that writes the ledger
- [Try it offline](../guide/quickstart.md) — `bun run demo` drives a real run
  with a scripted model (no API key), then tampers with the receipt
