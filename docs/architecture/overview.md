# Architecture Overview

Alfred is a **verifiable autonomous coding agent CLI** built with TypeScript on Bun. Its thesis: the harness is *executable*, "done" is a *machine-enforced gate*, memory is *agent-curated but inspectable*, and every hands-off run leaves a *signed, replayable receipt*. This page describes the layered target architecture, its design principles, and how each subsystem maps to `src/`.

---

## Layer diagram

```text
 alfred run / exec ──▶  ORCHESTRATION (src/orchestrator)
                        agent() · parallel() · pipeline() · log()
                        journal (resume/replay) · token budget · HMAC ledger
                                    │ drives
                        AUTONOMY HARNESS (src/harness)
                        feature_list state machine · verify gate · rubric
                        checkpoint/rollback        workflows/autonomousRun.ts
                                    │ uses
  AGENT LOOP          MEMORY              TOOLS · PERMISSIONS · SANDBOX · CONTEXT
  (src/query)         (src/memory)        (src/tools, src/permissions,
  retry · fallback ·  file-first, FTS5,   src/sandbox, src/context)
  stream · compact ·  episodes, GC        fs/bash/glob/grep/web_fetch/memory/skill
  typed status · cost                     hooks · MCP · LSP
                        └─────────── PROVIDERS (src/providers) ────────────┘
                                    anthropic / openai / mock
  cross-cutting:
    security (src/security)    — taint · egress · redact · quarantine
    observability (src/telemetry, src/cost, src/eval)
                               — OTel GenAI spans · cost tracker · eval harness
    routing (src/config/roles.ts)
                               — architect / editor / subagent role map
    code intelligence (src/context/repomap.ts, src/tools/lsp/)
                               — repo map · post-edit syntax check · LSP client
```

Each new piece is *additive*, not a rewrite. The orchestration and harness layers sit over the existing query engine and memory modules; the cross-cutting domains thread through every box.

---

## Design principles (P1–P7)

These seven principles are the selection criteria for the best-of-breed synthesis. When two sources disagree, Alfred picks the option that satisfies more of them.

| # | Principle | Meaning |
|---|---|---|
| **P1** | **File-first & inspectable** | Memory, skills, ledgers, and checkpoints are plain files in `.alfred/` — `cat`-able, `git diff`-able, hand-editable. No opaque databases as the default. |
| **P2** | **Provider-abstracted** | Anything with multiple credible backends (LLM provider, memory store, sandbox) goes behind a small interface with a zero-dependency local default. |
| **P3** | **Deterministic control flow** | Orchestration, the harness loop, stop conditions, and gates are *code*. The model fills boxes; the boxes are hand-wired. |
| **P4** | **Agent-proposes, machine-verifies** | The LLM proposes (what to remember, that a feature is done); a deterministic check disposes (exit codes, schema validation, contradiction scan, HMAC). |
| **P5** | **Progressive disclosure** | Large knowledge (skills, memory, tool catalogs, repo map) is indexed cheaply and loaded on demand — never dumped wholesale into the prompt. |
| **P6** | **Safe-by-default, escalate explicitly** | OS sandbox + ask-first approval; untrusted content quarantined; dangerous capabilities behind explicit flags. |
| **P7** | **Every run leaves a receipt** | Memory writes, tool calls, verify exit codes, git SHAs → an append-only, HMAC-signed ledger that doubles as an OTel trace. |

---

## Subsystems

### Orchestration — `src/orchestrator/`

The deterministic multi-agent runtime. Exposes `agent()`, `parallel()`, `pipeline()`, and `log()` as injected helpers into workflow functions. Sub-agent I/O is validated with Zod schemas. Runs are journaled to `.alfred/workflows/<runId>/journal.jsonl` — an append-only replay tape that doubles as a resume mechanism. A token budget (backed by `src/cost/tracker.ts`) caps spending per run.

Key files: `runtime.ts`, `agent.ts`, `journal.ts`, `budget.ts`, `ledger.ts`, `workflows/autonomousRun.ts`, `workflows/bestOfN.ts`.

### Autonomy harness — `src/harness/`

Realizes the `alfred run` command as a built-in workflow (`workflows/autonomousRun.ts`). Drives a `feature_list.json` state machine through a verify-fix inner loop: the model implements, `VERIFY_CMD` (`bun test` by default) decides pass/fail by exit code alone (P4), and a rubric self-eval gate checks the result. Git checkpoints allow rollback on consecutive blocks. Every step appends a row to the HMAC hash-chained run ledger (P7).

Key files: `featureList.ts`, `verify.ts`, `checkpoint.ts`, `episodes.ts`.

### Agent loop — `src/query/`

Async-generator loop over a provider. Handles retry with backoff, model fallback, typed terminal status, permission gating, parallel execution of read-only tools, token streaming, and context compaction. Emits OTel spans and a running cost tally.

Key files: `engine.ts`, `retry.ts`, `types.ts`.

### Memory v2 — `src/memory/`

File-first tiered store. Three tiers: **Core** (`USER.md` + `MEMORY.md` index, always injected, token-budgeted), **Recall** (`facts/*.md` + SQLite FTS5 search, fetched on demand), **Archival** (aged-out summaries). A 4-stage flow — inject → prefetch → sync → extract — threads through the agent loop. On session end the agent curates: dedup, contradiction/staleness GC, and writes a durable `episodes/<id>.json` record tying goal, approach, verify exit, git SHA, and cost. Model-facing tools (`memory_search`, `memory_upsert`, `memory_forget`) form the CRUD surface (P4: agent proposes, GC verifies).

Key files: `localFile.ts`, `types.ts`, `episodes.ts`. Interface: `MemoryProvider` (seam for future Mem0/Zep adapters, P2).

### Tools · Permissions · Sandbox · Context — `src/tools/`, `src/permissions/`, `src/sandbox/`, `src/context/`

The model's capability surface.

- **Tools** (`src/tools/`): `file_read`, `file_write`, `file_edit` (fuzzy seek-sequence match + post-edit tree-sitter syntax check), `bash`, `glob`, `grep`, `web_fetch`, `memory_*`, `load_skill`. LSP tools (`src/tools/lsp/`): `definition`, `references`, `hover`, `diagnostics`.
- **Permissions** (`src/permissions/`): tiered approval policy (allow / ask / deny). A hard DENY and the bash kill-list beat `bypass` at every level.
- **Sandbox** (`src/sandbox/`): macOS seatbelt (`seatbelt.ts`), enabled via `ALFRED_SANDBOX=1`; no-op on other platforms.
- **Context** (`src/context/`): system-prompt assembly, `CLAUDE.md`/`AGENTS.md` discovery, repo-map injection (`repomap.ts` — tree-sitter + PageRank into a token budget, P5).
- **Compact** (`src/compact/`): context-editing compaction — evicts stale tool results near the token limit.

### Providers — `src/providers/`

Thin adapters behind a shared interface. Implementations: `anthropic.ts`, `openai.ts`, `mock.ts`. Any Anthropic-compatible endpoint (e.g. Zhipu GLM) works by pointing `ALFRED_BASE_URL` at it — no code change required.

### Security — `src/security/`

Agent-layer defenses against prompt injection and exfiltration (distinct from OS sandboxing, which bounds *what the process can do*; this bounds *what untrusted content can make the agent do*):

- **Taint + fence** (`taint.ts`): `web_fetch`, MCP, and `bash` stdout are marked untrusted in `ToolUseContext` and wrapped as "untrusted data — not instructions." Longer-term, routed through a quarantined tool-less sub-agent (`quarantine.ts`) — the dual-LLM pattern, natural on the orchestrator.
- **Egress allow-list** (`egress.ts`): default-deny; configured via `ALFRED_EGRESS_ALLOW`.
- **Secret redaction** (`redact.ts`): scrubs `.env`/key-shaped strings from context and the run ledger.

No mainstream harness — Claude Code, Cursor, Hermes, Copilot, Gemini CLI — ships these defenses. It is Alfred's most on-brand differentiator.

### Observability — `src/telemetry/`, `src/cost/`, `src/eval/`

- **OTel GenAI spans** (`telemetry/otel.ts`): wraps each `provider.chat`, tool call, and orchestrator agent/workflow in a `gen_ai.*` span following the OpenTelemetry GenAI semantic conventions; exports via OTLP (opt-in, `ALFRED_OTEL_FILE`).
- **Ledger as span tree**: the HMAC-signed run ledger and the OTel trace are one artifact — the Proof Receipt is simultaneously the observability export.
- **Cost tracker** (`cost/tracker.ts`): running token/USD tally per session.
- **Eval harness** (`eval/engine.ts`): replays recorded `MockProvider` trajectories through the real engine and asserts tool-call sequence, status, and text regressions. Invoked via `alfred eval <file>`.

### Model routing — `src/config/roles.ts`

Role-based model map with `{architect, editor, subagent}` slots, each resolvable to a provider+model. The architect role uses a strong reasoning model to produce a plan; the editor role uses a fast, cheap model to apply it as `file_edit` calls. Provider fallback retries on a different provider on `overloaded`. Configured via `ALFRED_MODEL_ARCHITECT`, `ALFRED_MODEL_EDITOR`, `ALFRED_MODEL_SUBAGENT`.

### Extensibility — `src/hooks/`, `src/mcp/`, `src/skills/`

- **Hooks** (`hooks/`): `PreToolUse`/`PostToolUse` matchers defined in `.alfred/hooks.json`; exit-2 blocks the tool call.
- **MCP client** (`mcp/`): bridges external MCP servers; outputs are marked untrusted by the security layer.
- **3-level skills** (`skills/`): procedural memory with progressive disclosure (P5) — Level 1 index auto-injected; Level 2/3 bodies loaded on demand via `load_skill`.

---

## Best-of-breed synthesis (§8 adopt/adapt/reject summary)

Alfred's design is grounded in a structured review of Hermes Agent (Nous Research), MemGPT/Letta, Anthropic's memory tool and context editing, Claude Code dynamic workflows, Aider (repo-map, architect/editor split), OpenHands (inference-time scaling), and the lethal-trifecta security literature. The full table is in [`improvement-proposal.md`](/improvement-proposal).

High-level outcomes:

| Domain | Key sources | Verdict |
|---|---|---|
| Memory v2 (file-first tiered) | Hermes + project's own CLAUDE.md | **Adopted** as core — two independent systems converged on the same design |
| Episodic records → signed ledger | MemGPT/Letta + provenant | **Adopted** — bridges self-improvement and the Proof Receipt |
| Contradiction / staleness GC | Holographic (Nous) + Hermes | **Adopted** |
| Context editing | Anthropic (-84 % tokens, 100-turn eval) | **Adopted** |
| Mem0 / Zep vector/graph stores | — | Rejected as default; seam designed for future adapters |
| Dynamic workflow runtime | Claude Code | **Adopted** — the connective tissue for auditable autonomy |
| Harness-as-workflow | Claude Code + Alfred spec | **Adopted** — the flagship; makes "autonomy" executable |
| best-of-N with objective reward | OpenHands | **Adopted** (exit code, not a trained critic) |
| HMAC signed run ledger | provenant / trace-vault | **Adopted** |
| Repo map (tree-sitter + PageRank) | Aider | **Adopted** |
| Post-edit syntax check | Aider / Kiro | **Adopted** |
| LSP client | LSP / Kiro / LSAP | **Adopted** |
| Agent-layer security (taint + fence + egress + redact + dual-LLM) | Willison lethal-trifecta / CaMeL | **Adopted** — no competitor ships this |
| OTel GenAI spans + ledger-as-spans | OTel GenAI semantic conventions | **Adopted** |
| Architect / editor model routing | Aider | **Adopted** |
| Full MemGPT OS emulation | — | **Rejected** — take the tiering; skip the complexity |
| General-purpose workflow DSL / marketplace | — | **Deferred** |
| Cloud control plane / hosted memory | — | **Rejected** — violates local-first |
| 16-wide orchestration concurrency (Claude Code) | — | **Adapted down** to low concurrency for a single-user CLI |

See [ADR 0001](/adr/0001-target-architecture) and [`improvement-proposal.md`](/improvement-proposal) §8 for the complete rationale.
