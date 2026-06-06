# ADR 0001 — Target architecture: the verifiable autonomous coding agent

**English** | [中文](./0001-target-architecture.zh-CN.md)

- **Status:** Proposed
- **Date:** 2026-06-05
- **Supersedes:** —
- **Companion docs:** [`improvement-proposal.md`](../improvement-proposal.md) (full design) · [`alfred-vs-the-field.md`](../alfred-vs-the-field.md) (the review this builds on)

## Context

Alfred began as a Claude Code–style CLI coding agent ("inspired by Claude Code"). A code-grounded review against OpenAI Codex CLI, Google Gemini CLI, and Anthropic Claude Code (see the field review) found genuinely clean bones — a `buildTool()` capability-flag factory, an `AsyncGenerator` query loop, a provider abstraction, and a *more opinionated autonomous-harness spec* (this repo's `CLAUDE.md` / `feature_list.json` / `evaluator-rubric.md` / `.harness/`) than any of the three reference CLIs ship.

It also found a consistent **"library built, never wired"** pattern: the system-prompt builder, streaming, compaction, cost tracking, and the MCP/skills/plugins loaders all exist as code that nothing at runtime calls, and the headline autonomy capability lives only as prose.

That raises a strategic fork: **(a)** spend the budget reaching streaming/sandbox/caching *parity* with the reference CLIs, or **(b)** wire up the bones and lean into the one thing this repo already designed better than the field — *enforced, auditable autonomy*.

## Decision

Adopt **(b)**: position Alfred as the **verifiable autonomous coding agent**, and pursue a *best-of-breed* target architecture (detailed in the improvement proposal) rather than a clone. Concretely:

1. **Memory v2** — file-first, tiered (core / recall / archival), agent-curated, provider-abstracted memory, synthesizing Hermes Agent (Nous), MemGPT/Letta, Anthropic's memory tool + context editing, and this project's own `CLAUDE.md` file-per-fact pattern. Default to a local `LocalFileProvider` (SQLite FTS5); design the provider seam for Mem0/Zep but do not ship them.
2. **Dynamic workflows** — a deterministic `agent()/pipeline()/parallel()` orchestration runtime (the Claude Code dynamic-workflow model) built on the existing query engine + Zod structured output, with a journal that doubles as a replay tape.
3. **Harness-as-workflow** — realize the `CLAUDE.md` autonomous loop as a *built-in workflow*: a `feature_list.json` state machine → verify-fix inner loop against `init.sh`'s `VERIFY_CMD` (`bun test`) exit code → a code-enforced rubric gate → checkpoint/rollback → an **HMAC-signed, replayable run ledger**.
4. **Four cross-cutting domains**, each its own ADR — **code intelligence** (repo-map + LSP, [ADR 0002](./0002-code-intelligence.md)), **agent-layer security** (lethal-trifecta defenses, [ADR 0003](./0003-agent-layer-security.md)), **observability** (OTel GenAI spans + ledger-as-spans, [ADR 0004](./0004-observability-and-evals.md)), and **model routing** (architect/editor split, [ADR 0005](./0005-model-routing.md)).

Cross-cutting principles: **local-first & inspectable**, **provider-abstracted**, **deterministic control flow** (the model fills boxes; the boxes are hand-wired — consistent with this repo's `CLAUDE.md` Rule 5, "代码能回答的，让代码回答"), **agent-proposes / machine-verifies**, and **every run leaves a receipt**.

## Consequences

**Positive**
- The headline claim ("autonomy") becomes *executable and auditable*, not prose — a clear differentiator.
- Ties Alfred into a coherent "provable agent reliability" portfolio alongside `trace-vault` (record/replay) and `provenant` (HMAC Proof Receipts).
- The memory choice converges with a design already validated by two independent systems (Hermes + this repo's CLAUDE.md), lowering risk.
- Reuses existing assets (query engine, Zod, `src/memory/*`, `src/tools/agent.ts`, the harness spec) rather than rewriting.

**Negative / cost**
- Larger scope than parity-only work; must be staged.
- Introduces a provider abstraction (memory) whose second backend may not ship soon — risk of an unused seam (mitigated by keeping the interface tiny).
- Prefetched memory vs. prompt-cache hit-rate is a real tension (mitigated: stable Core is cached; prefetch is append-only and context-edited out).

**Sequencing (dependency-ordered).** Memory and orchestration both require the system prompt to be wired and the loop to be robust, so the review's P0 fixes come first:

- **Phase 0 — Foundations:** wire the system prompt, retry/backoff, stop hardcoding `bypass` + kill-list + path jail, fuzzy edit + mtime, real invoked compaction, typed terminal status.
- **Phase 1 — Memory v2.**
- **Phase 2 — Orchestrator + harness fusion** (the flagship).
- **Phase 3 — Parity polish** (streaming, caching, sandbox, hooks, MCP, 3-level skills, best-of-N).
- **Phase 4 — Alfred-Bench:** Alfred rebuilds its own `feature_list.json` from an empty `src/` under held-out verification.

## Alternatives considered

- **Pure clone parity.** Rejected: undifferentiated; the field is already ahead on streaming/sandbox/caching and will stay ahead.
- **Cloud-hosted memory / orchestration (Zep graph, hosted vector DB as the default).** Rejected as the *foundation*: violates local-first & inspectable; kept as optional provider adapters.
- **Full MemGPT OS emulation / general-purpose workflow DSL on day one.** Rejected: take the tiering and the orchestration primitives; defer the heavyweight generality until a concrete need appears (this repo's Rule 2, 最简优先).

## Related ADRs

- [0002 — Code intelligence (repo-map + LSP)](./0002-code-intelligence.md)
- [0003 — Agent-layer security (lethal trifecta)](./0003-agent-layer-security.md)
- [0004 — Observability & evals (OTel GenAI)](./0004-observability-and-evals.md)
- [0005 — Model routing (architect/editor split)](./0005-model-routing.md)

## References

See [`improvement-proposal.md` §11](../improvement-proposal.md#11-sources) and [`alfred-vs-the-field.md` §6](../alfred-vs-the-field.md) for full citations (Hermes Agent, MemGPT/Letta, Anthropic memory tool & context editing, Claude Code dynamic workflow, lethal-trifecta security, OTel GenAI, Aider repo-map/architect-editor, LSP, Codex/Gemini sandboxing, OpenHands, SWE-bench Verified).
