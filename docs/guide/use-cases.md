# Use cases

Four scenarios where enforced, auditable autonomy pays for itself — each
mapped to commands you can run today. If you want to *see* the mechanics
first, the [offline demo](./quickstart.md#offline-demo) takes 30 seconds and
needs no API key.

---

## Overnight autonomous builds {#overnight}

You have a backlog of small, well-specified features and an evening. Hand the
harness a `feature_list.json`, a verify command, and a budget — read the
receipts in the morning.

```bash
ALFRED_LEDGER_SECRET=$(openssl rand -hex 32) \
alfred run \
  --verify "bun test" \
  --verify-fast "bun test tests/affected" \
  --max-features 10 \
  --budget-usd 5 \
  --rollback-on-block
```

What you wake up to:

- `feature_list.json` — which features went `passing` vs `blocked` (the state
  machine never marks done on the model's word; only a captured `exit 0` plus
  a rubric pass does it).
- `.alfred/workflows/<runId>/ledger.jsonl` — one signed row per feature:
  verify exit code, rubric score, git SHA, reason if blocked.
- `alfred ledger verify` — confirm nobody (including a misbehaving tool call)
  edited the history.
- Blocked features rolled back to their checkpoint, not left half-applied
  (`--rollback-on-block`).

The budget is a hard stop, the iteration budget per feature is tier-aware, and
two consecutive blocked features end the run early — failure modes are
bounded by code, not by model judgment.

---

## CI gates for agent changes {#ci-gate}

You changed a prompt, a tool, or bumped a model. Did agent behaviour regress?
`alfred eval` replays recorded trajectories through the **real** engine —
tools, permissions, loop and all — and asserts observable properties. Only the
LLM is mocked, so it runs in CI **with no API key and zero flakiness**.

```bash
alfred eval ./evals/cases.ts   # exits non-zero on any regression
```

```yaml
# .github/workflows/ci.yml
- name: Agent regression gate
  run: bun run src/index.ts eval ./evals/cases.ts
```

Assertions cover tool-call sequences, terminal status, and answer text — see
[alfred eval](../cli/eval.md) for the `EvalCase` contract. The offline demo in
[`examples/demo`](https://github.com/BeamusWayne/Alfred/tree/main/examples/demo)
uses the same mechanism end-to-end (`ALFRED_MOCK_SCRIPTS`).

---

## Hands-off runs on untrusted input {#untrusted}

Triaging an external bug report, summarising a webpage, working with
third-party code: the content your agent reads is an attack surface
(prompt injection → secret exfiltration — the "lethal trifecta").
Alfred ships content-layer defenses no mainstream harness enables:

```bash
export ALFRED_EGRESS_ALLOW="api.github.com"   # default-deny outbound fetch
export ALFRED_QUARANTINE=1                    # dual-LLM quarantine of untrusted output
export ALFRED_SANDBOX=1                       # OS-sandboxed bash (macOS seatbelt)
alfred --permission-mode default "triage the crash in issue.txt and propose a fix"
```

- Untrusted tool output is **taint-fenced** so instructions inside it are
  inert data, not commands.
- `web_fetch` egress is allow-listed; everything else is denied by default.
- Secret-shaped strings are redacted before they reach logs or the ledger.

See [Security](../subsystems/security.md) and ADR 0003 for the threat model.

---

## Receipts you can hand to a reviewer {#receipts}

"An agent wrote this" is increasingly a compliance question: *what ran, what
checked it, and can you prove the record wasn't edited after the fact?*

Every `alfred run` writes a hash-chained, HMAC-signed ledger — redacted before
signing, so it is safe to share:

```bash
alfred ledger verify                       # latest run
alfred ledger verify path/to/ledger.jsonl  # a receipt someone sent you
```

- Any edited row → `✗ TAMPER DETECTED at row N: Signature mismatch` (exit 1).
- Reordered or dropped rows → `prevSig` / `seq` mismatch.
- A lopped-off tail → the signed head anchor catches what a pure hash chain
  provably cannot.

Wire it as the last step of any autonomous pipeline — see
[alfred ledger](../cli/ledger.md) for the CI snippet.
