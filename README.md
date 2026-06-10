# Alfred

**A verifiable autonomous coding agent (CLI).** Built with TypeScript on the [Bun](https://bun.sh) runtime.

Alfred is not another Claude Code clone. Its thesis: the long-running harness is *executable*, "done" is a *machine-enforced gate*, memory is *agent-curated but inspectable*, and every hands-off run leaves a *signed, replayable receipt*. Where the field is ahead on streaming/sandbox/caching parity, Alfred leans into the one thing it designs better — **enforced, auditable autonomy** — while still adopting the best ideas from across the ecosystem (`docs/improvement-proposal.md`).

> Status: 739 tests passing · `tsc --noEmit` clean · zero runtime dependencies beyond `@anthropic-ai/sdk`, `commander`, `zod`.

**📖 Full documentation** lives in [`docs/`](./docs/) as a VitePress site — run `bun run docs:dev` locally, or deploy to GitHub Pages via [`.github/workflows/docs.yml`](./.github/workflows/docs.yml). Jump to [Quickstart](./docs/guide/quickstart.md) · [CLI reference](./docs/cli/overview.md) · [Subsystems](./docs/subsystems/agent-loop.md) · [Architecture](./docs/architecture/overview.md).

---

## Quickstart

```bash
bun install

# One-shot agent run (text → stdout, traces → stderr)
export ANTHROPIC_API_KEY=sk-ant-...
bun run src/index.ts -p "explain what this repo does"

# Autonomous harness: drive a feature_list.json to green under a verify gate
ALFRED_LEDGER_SECRET=$(openssl rand -hex 32) \
  bun run src/index.ts run --verify "bun test" --max-features 5

# Replay recorded trajectories as regression tests (CI gating)
bun run src/index.ts eval ./my-cases.ts

bun test tests     # 739 tests
bun run typecheck # tsc --noEmit
```

---

## Commands

| Command | What it does |
|---|---|
| `alfred [prompt]` | One-shot agent run. `-p` print mode; `--model`, `--permission-mode`, `--max-turns`, `--yes`. |
| `alfred run` | The **autonomous harness as a workflow**: a `feature_list.json` state machine → verify-fix loop → rubric gate → signed run ledger. Flags: `--feature-list`, `--verify`, `--max-features`, `--rollback-on-block`, `--budget-usd`. |
| `alfred eval <file>` | Replay recorded `MockProvider` trajectories through the real engine and assert tool-sequence / status / text regressions. Exits non-zero on failure. |

---

## Architecture

Layers over a clean agent loop — each new piece is additive, not a rewrite. The mapping to the architecture decision records lives in `docs/adr/`.

```
 alfred run / exec ─▶ ORCHESTRATION (src/orchestrator) ──── agent()/parallel()/pipeline()
                      journal (resume/replay) · token budget · HMAC ledger
                                  │ drives
                      AUTONOMY HARNESS (src/harness) ─────── feature_list state machine ·
                      verify gate · rubric · checkpoint/rollback   workflows/autonomousRun
                                  │ uses
   AGENT LOOP (src/query) ── MEMORY (src/memory) ── TOOLS · PERMISSIONS · SANDBOX · CONTEXT
   retry · fallback ·         file-first, FTS5,      fs/bash/glob/grep/web_fetch/memory/skill
   stream · compaction ·      episodes, GC          fuzzy-edit · post-edit syntax check
   typed status · cost                              hooks · MCP · LSP
                      └──────── PROVIDERS (anthropic / openai / mock) ────────┘
              cross-cutting: security (taint/egress/redact/quarantine) · telemetry (OTel) · routing
```

### Subsystems (and the ADR each realizes)

- **Agent loop** (`src/query/`) — async-generator loop with retry/backoff + model fallback chain, typed terminal status, permission gating, parallel read-only tools, **token streaming**, context compaction, OTel spans + running cost.
- **Memory v2** (`src/memory/`, ADR 0001 §4) — file-first tiered store (`USER.md` + `MEMORY.md` index + `facts/*.md` + `episodes/`), SQLite FTS5 search, staleness/contradiction GC. Model-facing `memory_search/upsert/forget` tools.
- **Orchestrator** (`src/orchestrator/`, ADR 0001 §5) — `agent()/parallel()/pipeline()/log()` runtime over the engine, append-only **journal** (resume + replay tape), token **budget**, and an HMAC **hash-chained ledger** (the Proof Receipt). `best-of-N` inference-time scaling.
- **Harness** (`src/harness/`, ADR 0001 §7.7) — `feature_list.json` state machine, an **objective verify gate** (trusts only an exit code), a rubric self-eval gate, git checkpoint/rollback. `workflows/autonomousRun.ts` is the flagship.
- **Code intelligence** (ADR 0002) — repo map (`src/context/repomap.ts`, PageRank into a token budget), **post-edit tree-sitter-style syntax check** in `file_edit`, and an **LSP client** (`src/tools/lsp/`).
- **Agent-layer security** (`src/security/`, ADR 0003) — taint **fence**, **egress allow-list** (default-deny), secret **redaction**, and a **dual-LLM quarantine** for untrusted content. `web_fetch` is the model citizen for all three.
- **Observability** (`src/telemetry/`, `src/cost/`, ADR 0004) — OTel GenAI semantic-convention spans, a cost tracker, and an **eval harness** (`src/eval/`).
- **Model routing** (`src/config/roles.ts`, ADR 0005) — architect/editor/subagent role→model map + fallback chain. Providers: Anthropic + OpenAI + a scriptable mock.
- **Extensibility** — **hooks** (`src/hooks/`, PreToolUse/PostToolUse, exit-2-blocks), **OS sandbox** (`src/sandbox/`, macOS seatbelt), **MCP** client (`src/mcp/`), **3-level skills** (`src/skills/`).

---

## Configuration (opt-in env flags)

| Env var | Effect |
|---|---|
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Provider credentials. |
| `ALFRED_PROVIDER` | `anthropic` (default) or `openai`. |
| `ALFRED_BASE_URL` | Override the provider base URL — point at any Anthropic-compatible endpoint (e.g. Zhipu GLM). |
| `ALFRED_MODEL` | Default model. `ALFRED_MODEL_{ARCHITECT,EDITOR,SUBAGENT}` for role routing — a bare model id, or `provider:model` (e.g. `openai:gpt-5.2`) to pin a role to another provider. |
| `ALFRED_EFFORT` | Reasoning effort on supporting models: `low`/`medium`/`high`/`xhigh`/`max`. Defaults per role (architect `xhigh`, editor `medium`, subagent `low`). |
| `ALFRED_THINKING=none` | Opt out of adaptive thinking (on by default for models that support it, e.g. Claude Fable 5 / Opus 4.6+ / Sonnet 4.6). |
| `ALFRED_MEMORY=1` | Inject agent memory Core + run staleness GC on session end. |
| `ALFRED_REPOMAP=1` | Inject a repo map into the system prompt. |
| `ALFRED_SANDBOX=1` | Run `bash` inside an OS sandbox (macOS seatbelt; no-op elsewhere). |
| `ALFRED_OTEL_FILE=path.jsonl` | Export OTel GenAI spans. |
| `ALFRED_EGRESS_ALLOW=host1,*.host2` | `web_fetch` egress allow-list (default-deny). |
| `ALFRED_LEDGER_SECRET` | HMAC secret for the autonomous run ledger. |
| `ALFRED_VERIFY_CMD` | Default verify command for `alfred run` (default `bun test`). |

### Using GLM, or any Anthropic-compatible endpoint

The `anthropic` provider speaks the Messages API, so any compatible gateway works by pointing `ALFRED_BASE_URL` at it — no code change. Zhipu **GLM** works out of the box (and is exercised end-to-end in this repo's dogfood):

```bash
export ALFRED_BASE_URL="https://open.bigmodel.cn/api/anthropic"
export ANTHROPIC_API_KEY="<your-zhipu-key>"
bun run src/index.ts -p --model glm-5.1 "hello"
# the same env applies to `alfred run`
```

Pricing for `glm-4.5` / `glm-4.6` / `glm-5.1` ships in the cost table; unknown models fall back to a default estimate.

### Local state — `.alfred/` (git-ignored, inspectable)

```
.alfred/
  memory/    USER.md · MEMORY.md · facts/<slug>.md · episodes/ · index.db
  skills/    <name>/SKILL.md          (Level-1 index auto-injected; load_skill loads bodies)
  hooks.json                          (PreToolUse/PostToolUse matchers)
  workflows/<runId>/journal.jsonl     (resume/replay tape)
  workflows/<runId>/ledger.jsonl      (HMAC hash-chained Proof Receipt)
```

---

## Security model

Two orthogonal axes (ADR 0001 §7.3, ADR 0003): a tiered **approval policy** (allow/ask/deny — a hard DENY and the bash kill-list beat even `bypass`) and a **content-trust boundary**. Untrusted tool output (`web_fetch`, MCP) is tainted and **fenced** as data-not-instructions; egress is allow-listed; secrets are redacted; and untrusted content can be routed through a **quarantined, tool-less sub-agent** (dual-LLM). No mainstream harness ships this lethal-trifecta defense — it is Alfred's most on-brand differentiator.

---

## Roadmap status

| Phase | Scope | Status |
|---|---|---|
| 0 | Foundations (wired prompt, retry, permissions, fuzzy edit, typed status, syntax check) | ✅ |
| 1 | Memory v2 + repo-map + security primitives + model routing + compaction | ✅ |
| 2 | Orchestrator + harness-as-workflow + `alfred run` (signed ledger) | ✅ |
| 3 | Parity + extensibility: streaming, caching, hooks, sandbox, MCP, skills, OpenAI, LSP, eval, best-of-N | ✅ |
| 4 | **Alfred-Bench** — rebuild itself from an empty `src/` under held-out verification | scaffolded — see `docs/alfred-bench.md` |

Known follow-ups (libraries built + tested, startup wiring pending): MCP/LSP server bootstrap from `.alfred/{mcp,lsp}.json`; cross-provider fallback (model→provider routing).

Design docs: `docs/improvement-proposal.md` (the best-of-breed synthesis) and `docs/adr/0001`–`0005`.

## License

MIT
