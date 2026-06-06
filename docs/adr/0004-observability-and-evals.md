# ADR 0004 — Observability, telemetry & evals

**English** | [中文](./0004-observability-and-evals.zh-CN.md)

- **Status:** Proposed
- **Date:** 2026-06-05
- **Relates to:** [ADR 0001](./0001-target-architecture.md) · [`improvement-proposal.md` §6.3](../improvement-proposal.md#63-observability-telemetry--evals)

## Context

Alfred's whole thesis is *provable* reliability, but nothing is instrumented: the `CostTracker` (`src/cost/tracker.ts`) is never consulted (review), and events are `console.log`/chalk strings (`src/repl.ts`). There is no span model, no trajectory export, and no eval harness — so the reliability claim is currently unprovable.

The field standard is the **OpenTelemetry GenAI semantic conventions**: `gen_ai` spans for model calls, agent invocations, workflow spans, and `execute_tool {gen_ai.tool.name}`, with token/cost/session attributes. Any backend (Datadog, Honeycomb, Langfuse, LangSmith) renders these without bespoke code.

## Decision

1. **OTel GenAI spans** — `src/telemetry/otel.ts`: wrap each `provider.chat`, tool call, and orchestrator agent/workflow in a `gen_ai.*` span; export via OTLP (opt-in env).
2. **The run ledger IS the span tree** — emit the [ADR 0001](./0001-target-architecture.md)/§5.3 HMAC-signed ledger as OTel spans, so the receipt and the observability trace are *one artifact* (ties `trace-vault`).
3. **Eval harness** — `src/eval/`: replay recorded sessions and assert tool-call / verify-exit regressions.

## Consequences

- **Positive:** makes "provable reliability" literally exportable and standard; one artifact serves both audit (HMAC) and observability (OTel); enables regression evals on the agent itself.
- **Negative/cost:** OTel SDK dependency; spans must avoid leaking secrets (coordinate with [ADR 0003](./0003-agent-layer-security.md) redaction); eval harness needs a corpus of recorded sessions.
- **Phasing:** OTel spans + ledger-as-spans P2 (M); eval harness P3.

## Alternatives considered

- **Bespoke JSON logs only.** Rejected: re-invents a worse, non-portable subset of OTel; no free backend support.
- **A hosted tracing SaaS as the default.** Rejected: violates local-first; OTLP export is opt-in and points wherever the user chooses (including a local collector).

## References

See [`improvement-proposal.md` §11](../improvement-proposal.md#11-sources) — [O1] OTel GenAI agent spans, [O2] Datadog OTel GenAI support.
