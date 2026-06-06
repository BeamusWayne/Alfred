# Architecture Decision Records

Alfred's architectural choices are captured as ADRs — short, immutable records of the context, decision, and trade-offs at the time. This page summarises each one; follow the link for the full text.

::: info Phased rollout
The decisions below are dependency-ordered across five phases. Phases 0–3 are complete; Phase 4 is scaffolded.

| Phase | Scope | Status |
|---|---|---|
| **0** | Foundations — wired system prompt, retry/backoff, permission kill-list/path-jail, fuzzy edit + mtime, real compaction, typed terminal status, post-edit syntax check | Done |
| **1** | Memory v2 + repo-map + security primitives + model routing + compaction | Done |
| **2** | Orchestrator + harness-as-workflow + `alfred run` (signed ledger) | Done |
| **3** | Parity + extensibility: streaming, caching, hooks, sandbox, MCP, 3-level skills, OpenAI provider, LSP client, eval harness, best-of-N | Done |
| **4** | **Alfred-Bench** — rebuild itself from an empty `src/` under held-out verification | Scaffolded |
:::

---

## ADR 0001 — Target architecture: the verifiable autonomous coding agent

**Full record:** [/adr/0001-target-architecture](/adr/0001-target-architecture)

**Context.** A code-grounded review against Codex CLI, Gemini CLI, and Claude Code found clean bones in Alfred — a `buildTool()` factory, an `AsyncGenerator` query loop, a provider abstraction — but a consistent "library built, never wired" pattern: streaming, compaction, cost tracking, and MCP/skills loaders all existed as code that nothing at runtime called. The strategic question was whether to chase streaming/sandbox/caching parity with the reference CLIs, or to wire up the existing bones and lean into the one thing Alfred already designed better: enforced, auditable autonomy.

**Decision.** Adopt position **(b)**: the verifiable autonomous coding agent, built via a best-of-breed synthesis rather than a clone. Four concrete pillars: (1) **Memory v2** — file-first tiered store synthesising Hermes Agent, MemGPT/Letta, Anthropic's memory tool + context editing, and this project's own `CLAUDE.md` file-per-fact pattern; (2) **Dynamic workflow runtime** — deterministic `agent()/pipeline()/parallel()` orchestration built on the existing query engine with Zod structured output and a journal that doubles as a replay tape; (3) **Harness-as-workflow** — the autonomous loop realised as a built-in `feature_list.json` state machine → verify-fix loop → rubric gate → HMAC-signed replayable ledger; (4) **Four cross-cutting domains** (code intelligence, agent-layer security, observability, model routing), each with its own ADR.

---

## ADR 0002 — Code intelligence: repo map + LSP

**Full record:** [/adr/0002-code-intelligence](/adr/0002-code-intelligence)

**Context.** Alfred's only code-navigation tools were `glob` and `grep` — pure text search with no structural or semantic awareness. The model could not answer "where is this symbol defined/used," could not surface types, and `file_edit` could write syntactically broken code caught only later by `bun test` (if a test covered it). On a large repo the model greps blindly and burns turns. Aider's repo map (tree-sitter `def`/`ref` tags → symbol graph → PageRank into a fixed token budget) and LSP-based semantic precision (~50 ms call-site lookup vs. seconds of recursive grep) are the field-proven answers; Hermes Agent independently added both (issues #535, #516).

**Decision.** Add code intelligence in three steps: (1) **Repo map** (`src/context/repomap.ts`) — tree-sitter via `web-tree-sitter` + PageRank into a token budget, injected adjacent to memory Core; (2) **Post-edit tree-sitter syntax check** in `src/tools/fileEdit.ts` — reject an edit whose result does not parse (cheap; kills a whole class of failures before the verify loop); (3) **LSP client** (`src/tools/lsp/`) — thin JSON-RPC client exposing `definition`/`references`/`hover`/`diagnostics` as tools, feeding diagnostics into the harness verify loop.

---

## ADR 0003 — Agent-layer security: prompt-injection & exfiltration defense

**Full record:** [/adr/0003-agent-layer-security](/adr/0003-agent-layer-security)

**Context.** This is distinct from OS sandboxing (which bounds *what the process can do*); this bounds *what untrusted content can make the agent do*. The threat is Simon Willison's **lethal trifecta** — private data + untrusted content + an exfiltration channel in one context; any two are safe, all three is exploitable. Alfred had the full trifecta wide open: private repo data, untrusted content (`web_fetch` fetching arbitrary URLs, MCP bridge piping arbitrary server output verbatim into context), and exfiltration channels (no-egress `bash`/`web_fetch`). No mainstream harness — Claude Code, Cursor, Hermes, Copilot, Gemini CLI — ships these defenses.

**Decision.** Defense-in-depth at the content layer: (1) **Taint + fence** (`src/security/taint.ts`) — mark `web_fetch`/MCP/`bash`-stdout as untrusted in `ToolUseContext`, wrap in a "untrusted data — not instructions" block, and longer-term route through a quarantined tool-less sub-agent (`src/security/quarantine.ts`, the dual-LLM pattern, natural on the orchestrator); (2) **Egress allow-list** (`src/security/egress.ts`) — enforced in `web_fetch` and the sandbox, blocking exfiltration to non-allowlisted hosts; (3) **Secret redaction** (`src/security/redact.ts`) — scrub `.env`/key-shaped strings from context and the run ledger.

---

## ADR 0004 — Observability, telemetry & evals

**Full record:** [/adr/0004-observability-and-evals](/adr/0004-observability-and-evals)

**Context.** Alfred's thesis is *provable* reliability, but nothing was instrumented: `CostTracker` was never consulted, and events were `console.log`/chalk strings with no span model, no trajectory export, and no eval harness — so the reliability claim was unprovable. The field standard is the **OpenTelemetry GenAI semantic conventions** (`gen_ai.*` spans for model calls, agent invocations, workflow spans, and tool executions), which any backend — Datadog, Honeycomb, Langfuse, LangSmith — renders without bespoke code.

**Decision.** Three pieces: (1) **OTel GenAI spans** (`src/telemetry/otel.ts`) — wrap each `provider.chat`, tool call, and orchestrator agent/workflow in a `gen_ai.*` span, exported via OTLP (opt-in via `ALFRED_OTEL_FILE`); (2) **Ledger as span tree** — emit the HMAC-signed run ledger as OTel spans so the Proof Receipt and the observability trace are one artifact; (3) **Eval harness** (`src/eval/`) — replay recorded `MockProvider` trajectories through the real engine and assert tool-call sequence, terminal status, and text regressions (invoked via `alfred eval <file>`).

---

## ADR 0005 — Model routing & the architect–editor split

**Full record:** [/adr/0005-model-routing](/adr/0005-model-routing)

**Context.** Alfred had a clean provider abstraction (`src/providers/`) but used one `config.model` for everything — expensive reasoning and cheap mechanical edits paid the same model. There was no architect/editor split, no per-role routing, and no fallback chain. This contradicted the project's own token-budget rule. The proven coding-agent pattern is **architect/editor separation**: a strong reasoning model *plans* the change in prose; a fast, cheap model *applies* it as precise edits. Aider reports this decomposition yields SOTA edit-benchmark results; Claude Code uses the same tiering (Opus plan / Sonnet code / Haiku sub-agents).

**Decision.** Three pieces: (1) **Role-based model map** (`src/config/roles.ts`) — extend `QueryConfig` and `src/config/manager.ts` with `{architect, editor, subagent}` slots, each resolvable to a provider+model, configured via `ALFRED_MODEL_ARCHITECT` / `ALFRED_MODEL_EDITOR` / `ALFRED_MODEL_SUBAGENT`; (2) **Architect/editor in the harness** — the verify-fix loop runs the architect model to produce a plan and the editor model to turn it into `file_edit` calls; (3) **Provider fallback** in the retry layer — on `overloaded`, fail over to the alternate provider.
