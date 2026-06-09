# Minimal Alfred-Bench example

A tiny, reproducible [Alfred-Bench](../../docs/alfred-bench.md) run. The agent
must autonomously implement two functions — `slugify` and `truncate` — that pass
a **held-out** test suite it never sees during its turns, recorded in a signed,
tamper-evident ledger.

It demonstrates the three properties that make the result ungameable:

1. **Held-out verification** — `heldout/*.test.ts` are copied into the target
   only at check time (then removed), so the model can't read the gate.
2. **Dual FAIL→PASS** — the held-out suite must fail before the run and pass
   after; a pre-existing pass doesn't count.
3. **Signed ledger** — every outcome is HMAC hash-chained with a head anchor, so
   tampering (including tail truncation) is detectable.

## Run it

Needs a provider key (the model does real work):

```bash
# Google Gemini
ALFRED_PROVIDER=google GOOGLE_API_KEY=…  examples/bench/run.sh

# OpenAI
ALFRED_PROVIDER=openai OPENAI_API_KEY=…  examples/bench/run.sh

# Anthropic (or GLM via ALFRED_BASE_URL)
ALFRED_PROVIDER=anthropic ANTHROPIC_API_KEY=…  examples/bench/run.sh
```

Expected result:

```
[alfred-bench] features=2 passing=2 dualPassConfirmed=2 ledger=ok
```

(exit 0 only when every feature is dual-confirmed **and** the ledger verifies.)

## Files

| File | Role |
|------|------|
| `feature_list.json` | The two features the agent must build (copied into the temp target). |
| `heldout/*.test.ts` | The hidden acceptance tests (never present during the model's turns). |
| `run.sh` | Sets up a throwaway temp workspace, writes the `BenchSpec`, and runs `src/bench/cli.ts`. |

The model works in a `mktemp` directory; this committed example is read-only.
The held-out tests live outside the project's own `tests/` dir so `bun test`
never runs them.
