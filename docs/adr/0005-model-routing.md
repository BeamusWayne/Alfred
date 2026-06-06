# ADR 0005 — Model routing & the architect–editor split

**English** | [中文](./0005-model-routing.zh-CN.md)

- **Status:** Proposed
- **Date:** 2026-06-05
- **Relates to:** [ADR 0001](./0001-target-architecture.md) · [`improvement-proposal.md` §6.4](../improvement-proposal.md#64-model-routing--the-architecteditor-split)

## Context

Alfred has a clean provider abstraction (`src/providers/`) but uses **one `config.model` for everything** (`src/repl.ts` `resolveConfig`, default `glm-5.1`) — expensive reasoning and cheap mechanical edits pay the same model. There is no architect/editor split, no per-role routing, and no fallback. This contradicts the repo's own `CLAUDE.md` Rule 6 (token budget is a hard constraint).

The proven coding-agent pattern is **architect/editor separation**: a strong reasoning model *plans* the change in prose; a fast, cheap model *applies* it as precise edits. Aider reports this decomposition yields SOTA edit-benchmark results. Generalize to tiered routing (plan / code / sub-agent tiers) and fallback chains.

## Decision

1. **Role-based model map** — extend `QueryConfig` (`src/query/types.ts`) + `src/config/manager.ts` with `{architect, editor, subagent}` slots, each resolvable to a provider+model.
2. **Architect/editor in the harness** — in the [ADR 0001](./0001-target-architecture.md)/§5.3 verify-fix loop, run the architect model to produce a plan and the editor model to turn it into `fileEdit` calls.
3. **Provider fallback** — in the retry layer (review R1.1): on `overloaded`, fail over to the other provider.

## Consequences

- **Positive:** better edit accuracy (the proven win) *and* lower cost (cheap model does the mechanical work); honors the repo's token-budget rule; resilience via fallback.
- **Negative/cost:** more config surface; two models per task means two prompt formats to maintain; routing logic must stay deterministic ([ADR 0001](./0001-target-architecture.md) P3), not model-decided.
- **Phasing:** role map + fallback P1 (M); architect/editor in harness P2 (builds on §5).

## Alternatives considered

- **A learned router (RouteLLM-style).** Deferred: adds a model/dependency for marginal gain over a static role map at single-user scale.
- **One strong model for everything.** Rejected: violates the token-budget rule and leaves the measured architect/editor accuracy gain on the table.

## References

See [`improvement-proposal.md` §11](../improvement-proposal.md#11-sources) — [R1] Aider architect/editor mode.
