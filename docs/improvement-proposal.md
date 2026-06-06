# Alfred 改进方案书 — A Best-of-Breed Architecture Proposal

**English** | [中文](./improvement-proposal.zh-CN.md)

> **摘要(中文)**：本方案书在前一份《Alfred vs. the Field》代码级评审的基础上,提出 Alfred 的**目标架构**——不是再克隆一个 Claude Code,而是「取百家之长」融合成一个 *可验证的自治 coding agent*。两个重点引入:(A) **记忆系统**——融合 Hermes Agent(Nous Research)的五支柱/四阶段流/可插拔 provider、MemGPT/Letta 的 OS 三层模型、Anthropic 的 memory tool + context editing,以及你当前 CLAUDE.md 记忆体系的 file-first 自策展范式;(B) **dynamic workflow**——把 Claude Code 的动态工作流(确定性多 agent 编排)引入 Alfred,并与自治 harness 融合,使「自治即代码、每次运行可重放可审计」。此外 §6 再补四个交叉领域(代码智能、Agent 安全、可观测、模型路由)。每一项都给出**采纳 / 改造 / 不采纳**的综合评估和落到 `src/` 的文件映射。本文档供决策是否纳入 `docs/`。
>
> **Status:** Proposal / RFC · **Date:** 2026-06-05 · **Author basis:** code-grounded review of `BeamusWayne/Alfred` + web research (Hermes Agent, MemGPT/Letta, Claude memory tool, Mem0/Zep, Claude Code dynamic workflow, lethal-trifecta security, OTel GenAI, Aider repo-map/architect-editor, LSP). · **Companion doc:** `alfred-vs-the-field.md` (the gap analysis this builds on).

---

## 0. How to read this document

The companion review (`alfred-vs-the-field.md`) answered *"where is Alfred behind, and what are the must-fixes?"* — 7 dimensions, 54 recommendations, P0/P1/P2.

This proposal answers a **different** question: *"if we get to redesign Alfred's spine by taking the single best idea from each leading system, what should the target architecture be — and what do we deliberately reject?"* It is forward-looking and opinionated. It does **not** repeat the gap list; it assumes the P0 fixes happen and builds on top of them.

Two subsystems get deep treatment because you named them and because they are the two highest-leverage *architectural* (not bug-fix) moves: **§4 Memory** and **§5 Dynamic Workflows**. **§6** adds four more cross-cutting best-of-breed domains (code intelligence, agent security, observability, model routing). **§7** condenses the remaining spine. **§8** is the **综合评估** (adopt/adapt/skip) table. **§9** is phasing.

---

## 1. Vision & non-goals

**Vision (unchanged from the review, sharpened):** Alfred is the **verifiable autonomous coding agent** — the one CLI where the long-running harness is *executable*, "done" is a *machine-enforced gate*, memory is *agent-curated but inspectable*, and every hands-off run leaves a *signed, replayable receipt*. It is the coding-agent pillar of a "provable agent reliability" portfolio alongside `trace-vault` (record/replay) and `provenant` (HMAC Proof Receipts).

**Non-goals (what we will NOT chase):**

- ❌ Token-streaming/TUI polish *parity* as an end in itself — necessary (P1), not differentiating.
- ❌ A cloud control plane, hosted memory, or multi-tenant anything — Alfred is local-first and inspectable by design.
- ❌ A general-purpose multi-agent "OS." We adopt orchestration **only** where it makes autonomy auditable.
- ❌ Re-implementing every Hermes pillar (crons, soul) — we take memory + skills + the self-improving loop, and map crons→the harness scheduler, soul→an optional thin tone file.

**The one design tension to hold throughout:** *agent-curated* (the LLM decides what to remember / how to orchestrate) vs. *verifiable* (a human or a deterministic check can audit it). Every borrowed idea is bent toward the second pole — that is Alfred's whole reason to exist.

---

## 2. Design principles (the selection criteria for 取百家之长)

When two sources disagree, Alfred picks the option that satisfies more of these. They are how we decide what to borrow.

| # | Principle | Consequence |
|---|---|---|
| P1 | **File-first & inspectable** | Memory, skills, ledgers, checkpoints are plain files in `.alfred/` you can `cat`, `git diff`, and hand-edit. (Hermes' `MEMORY.md`/`USER.md`; your CLAUDE.md system; Aider's repo-map.) |
| P2 | **Provider-abstracted** | Anything with multiple credible backends (LLM, memory, sandbox) goes behind a small interface, with a zero-dependency local default. (Mirrors Alfred's existing `src/providers/` + `buildTool()` DNA; Hermes' memory-provider contract.) |
| P3 | **Deterministic where it matters** | Control flow (orchestration, harness loop, stop conditions, gates) is *code*, not model-decided. The model fills the boxes; the boxes are wired by hand. (Claude Code dynamic workflow; `trace-vault`; this repo's `CLAUDE.md` Rule 5.) |
| P4 | **Agent-curated, machine-verified** | The LLM proposes (what to remember, that a feature is done); a deterministic check disposes (exit codes, schema validation, contradiction scan, HMAC). |
| P5 | **Progressive disclosure** | Big knowledge (skills, memory, tool catalogs, repo map) is indexed cheaply and loaded on demand, never dumped. (Hermes/Claude skills; MemGPT paging; Aider PageRank.) |
| P6 | **Safe-by-default, escalate explicitly** | OS sandbox + ask-first; untrusted content quarantined; power behind scary flags. (Codex/Claude Code sandboxing; lethal-trifecta defenses.) |
| P7 | **Every run leaves a receipt** | Memory writes, tool calls, verify exit codes, git SHAs → an append-only, signable ledger that doubles as an OTel trace. (`provenant`/`trace-vault`.) |

---

## 3. Target architecture at a glance

```
                 ┌──────────────────────────────────────────────┐
   alfred run /  │              ORCHESTRATION (§5)              │   ← NEW: dynamic workflows
   alfred exec / │   workflow runtime: agent()/pipeline()/       │      (Claude Code model)
   alfred wf …   │   parallel()  · structured I/O (Zod) ·        │
                 │   journal+resume · token budget               │
                 └───────────────┬──────────────────────────────┘
                                 │ drives
        ┌────────────────────────▼───────────────────────────────┐
        │                  AUTONOMY HARNESS (§7.7)                 │   ← built-in workflows:
        │  feature_list state machine · verify-fix loop ·          │      verify-fix, best-of-N,
        │  rubric gate · checkpoint/rollback · HMAC run ledger      │      self-eval
        └───┬───────────────┬───────────────┬─────────────────────┘
            │ uses          │ uses          │ uses
   ┌────────▼──────┐ ┌──────▼───────┐ ┌─────▼────────────────────┐
   │  AGENT LOOP   │ │   MEMORY (§4)│ │  TOOLS · PERMISSIONS ·    │
   │ query/engine  │ │ tiered ·      │ │  SANDBOX · CONTEXT/CACHE  │
   │ retry·stream· │ │ file-first ·  │ │  (§7: fuzzy-edit, jail,   │
   │ typed status  │ │ provider ·    │ │   seatbelt, hooks, MCP,   │
   │               │ │ 4-stage flow  │ │   prompt-cache)           │
   └───────┬───────┘ └──────┬───────┘ └─────┬────────────────────┘
           └────────────────┴───────── PROVIDERS (Anthropic/OpenAI) ┘
                         everything emits → .alfred/ledger (signed)
```

The new pieces (**orchestration**, **memory v2**, **harness**) are *layers over Alfred's existing modules*, not rewrites. The four §6 domains are **cross-cutting** — they thread through every box above: **code intelligence** (better edits), **agent security** (taint/egress on every tool), **observability** (a span per box), **model routing** (the right model per box). The existing `src/query/engine.ts`, `src/memory/*`, `src/context/*`, `src/tools/agent.ts`, `src/tasks/*` are the attachment points.

---

## 4. Headline import A — the Memory System (百家之长 synthesis)

### 4.1 What each source does best

| System | The one idea worth stealing | Source |
|---|---|---|
| **Hermes Agent** (Nous) | **Agent-curated `USER.md` + `MEMORY.md`** + a **4-stage flow** (inject→prefetch→sync→extract) + a **pluggable provider contract** + "**stale memory is the #1 cause of weird behavior**" as a first-class GC concern. | [[H1]](#h1)[[H2]](#h2) |
| **MemGPT / Letta** | **OS tiering**: core (in-context RAM) / recall (searchable) / archival (cold disk), agent pages data in/out; **episodic coherence** ("yesterday we tried X and it failed"). | [[M1]](#m1) |
| **Anthropic memory tool + context editing** | Memory as a **client-side file directory the model CRUDs**; **context editing** auto-evicts stale *tool results* near the limit (−84% tokens, 100-turn eval). | [[A1]](#a1)[[A2]](#a2) |
| **Holographic / Hindsight (Hermes providers)** | A local **`fact_store`** with `add/search/probe/related/**reason**/**contradict**/update/remove/list` + `fact_feedback`; **`reflect`** passes. Contradiction & reflection as explicit operations. | [[H1]](#h1) |
| **Mem0 / Zep** | Mem0: dead-simple vector recall (good default ergonomics). Zep: **temporal** knowledge graph (facts have validity intervals). | [[F1]](#f1) |
| **Your CLAUDE.md memory system** | **File-per-fact** with typed frontmatter (`user/feedback/project/reference`) + a **`MEMORY.md` index** loaded each session + "**update don't duplicate; delete what's wrong**". | (this repo) |

**The key realization:** Hermes' `USER.md`+`MEMORY.md`+agent-curation+staleness-GC is *the same design family* as the CLAUDE.md system you already use daily. Two independent, production systems converged on **file-first, agent-curated, indexed** memory. That convergence is the signal — Alfred should adopt it as the **core**, and treat vector/graph stores (Mem0/Zep) as *optional providers*, not the foundation.

### 4.2 Proposed architecture — "Alfred Memory v2"

**One sentence:** *tiered, file-first, agent-curated, provider-abstracted, and verifiable.*

**Layout (on disk, P1 file-first):**

```
.alfred/memory/
  USER.md                 # core: stable prefs/conventions (Hermes user.md ＋ your `type:user`)
  MEMORY.md               # core: one-line index of every fact (your index ＋ Hermes memory.md)
  facts/<slug>.md         # recall: one fact per file, frontmatter {type, scope, ts, ttl?}
  episodes/<id>.json      # episodic: per-task record {goal, approach, worked, failed, verifyExit, gitSha}
  archive/…               # archival: summarized/aged-out facts & episodes
  index.db                # recall: SQLite FTS5 over facts + session transcripts (Holographic-style)
```

**Tiers (MemGPT/Hermes OS model, P5 progressive disclosure):**

- **Core** — `USER.md` + `MEMORY.md` index + the active feature/progress pointer. *Always* injected into the system prompt, hard token-budgeted (e.g. ≤1.5k tokens; if the index outgrows it, summarize oldest into `archive/`). This is the "RAM."
- **Recall** — `facts/*.md` and session transcripts, retrieved on demand by a `memory` tool (search/get) and by **prefetch**. The "searchable disk."
- **Archival** — aged/again-summarized cold storage, retrievable but never auto-loaded.

**The 4-stage flow (Hermes), wired into the loop:**

1. **Inject** — `src/context/index.ts` puts Core into the system prompt (depends on P0 "wire the system prompt"). Place the volatile date **last** so the stable memory prefix stays cache-friendly (P1 of caching, §7).
2. **Prefetch** — before each turn in `src/query/engine.ts`, a *non-blocking* recall query on the latest user/goal text appends the top-k facts as ephemeral context (evicted by context-editing next turn).
3. **Sync** — after each turn, candidate facts are queued (not written synchronously — `writeFrequency` configurable: `turn|session|N`, per Hermes/Honcho).
4. **Extract** — on session/feature end, the agent curates: dedup, contradiction scan, write durable facts + an **episode record**.

**Curation = agent-proposes, machine-verifies (P4):**

- *Agent proposes* via memory tools (Claude memory-tool CRUD surface — Alfred already has `src/tools/memoryTool.ts`): `memory.upsert`, `memory.search`, `memory.get`, `memory.forget`, `memory.contradict`.
- *Machine verifies*: a deterministic **contradiction/staleness pass** (Holographic `contradict` + Hermes' staleness warning) runs on extract — flag facts with `ttl` expired, or whose `scope` (e.g. a file path) no longer exists, or that contradict a newer fact. This directly operationalizes Hermes' "stale memory is the #1 cause of weird behavior" instead of leaving it as advice.
- **Episodes are the bridge to autonomy:** after each feature, `episodes/<id>.json` records `{goal, approach, worked, failed, verifyExit, gitSha, cost}`. This is (a) Letta-style episodic coherence, (b) the input to the self-improving loop, and (c) — signed — a row in the **run ledger** (P7). "What did we try last time and did the tests pass?" becomes a real query.

**Provider abstraction (Hermes contract + Alfred DNA, P2):**

```ts
// src/memory/provider.ts
interface MemoryProvider {
  inject(ctx): Promise<MemoryBlock>          // Core → system prompt
  prefetch(query, k): Promise<Fact[]>        // Recall, non-blocking
  sync(turn): Promise<void>                   // queue candidates
  extract(session): Promise<void>             // curate on end
  search(q): Promise<Fact[]>; upsert(f); get(id); forget(id); contradict(f)
}
```

- **Default provider: `LocalFileProvider`** — the `.alfred/memory/` layout above + SQLite FTS5. Zero network, git-friendly, inspectable. This is the only one we *build*.
- **Optional adapters (later, community-grade):** `Mem0Provider`, `ZepProvider` — same contract, for users who want hosted vector/temporal-graph recall. We *design the seam*, we don't ship the backends.

**Map to Alfred files:**

| New/changed | Role |
|---|---|
| `src/memory/provider.ts` (new) | the interface above |
| `src/memory/providers/localFile.ts` (new) | default; replaces today's flat `src/memory/store.ts` + `search.ts` |
| `src/memory/episodes.ts` (new) | episode write/query |
| `src/tools/memoryTool.ts` (exists) | becomes the CRUD surface (upsert/search/get/forget/contradict) |
| `src/context/index.ts` (exists) | Core injection (after P0 wiring) |
| `src/query/engine.ts` (exists) | prefetch (pre-turn) + sync (post-turn) + extract (on end) hooks |
| `src/compact/engine.ts` (exists) | context-editing: evict stale *tool results*, not memory |

### 4.3 综合评估 — what we adopt / adapt / reject for memory

| Idea | Verdict | Why |
|---|---|---|
| Hermes `USER.md`+`MEMORY.md`, agent-curated, file-first | **Adopt** | Converges with your CLAUDE.md system; inspectable; git-friendly. The core. |
| Hermes 4-stage flow (inject/prefetch/sync/extract) | **Adopt** | Clean lifecycle; maps onto the loop cleanly. |
| Hermes pluggable provider contract | **Adopt (interface) / Adapt (backends)** | Build only the local provider; design the seam for Mem0/Zep. |
| MemGPT core/recall/archival tiering | **Adapt** | Take the tiering + token-budgeted core; *don't* emulate a full OS or self-editing-prompt complexity. |
| Episodic task records | **Adopt + extend** | The bridge to self-improvement *and* the signed ledger — Alfred's differentiator. |
| Holographic `contradict`/`reason`, Hindsight `reflect` | **Adopt (contradict/staleness) / Defer (reason/reflect)** | Contradiction+staleness GC is high-value and cheap; LLM "reflection" passes are nice-to-have. |
| Anthropic context editing (stale tool-result eviction) | **Adopt** | Orthogonal to memory; complements compaction; proven −84% tokens. |
| Mem0 (vector) as default | **Reject as default / Adapt as provider** | Adds a dependency/index for marginal gain over FTS5 at single-user scale; offer as adapter. |
| Zep temporal knowledge graph | **Reject as core / Adapt as provider** | Powerful but heavy + cloud-leaning; overkill for a CLI; future adapter only. |
| Hermes `soul.md` (personality) | **Adapt (optional)** | A thin optional tone file is cheap; not core for a coding agent. |
| Hermes crons | **Map, don't port** | The coding-agent analog is the harness scheduler / `alfred run`, not a personal-assistant cron. |

---

## 5. Headline import B — Dynamic Workflows (Claude Code model → Alfred)

### 5.1 What "dynamic workflow" actually is, and why it's the right import

Claude Code's **dynamic workflow** is *deterministic multi-agent orchestration as code*: a script with ordinary control flow (loops, conditionals, fan-out) that spawns sub-agents through a few injected helpers — `agent(prompt, {schema})`, `pipeline(items, …stages)`, `parallel(thunks)`, `log()` — where:

- **the control flow is code (P3 deterministic)** — the *structure* (what fans out, what verifies, what synthesizes) is authored by hand; only the *contents* of each box are model-generated;
- **sub-agent I/O is structured** — `schema` forces a validated object out of each agent (no brittle parsing);
- **runs are journaled & resumable** — a completed step returns a cached result on resume; the run is replayable;
- **there's a token budget** — the orchestration scales to a target.

This is exactly the missing connective tissue for Alfred's autonomy claim. Today Alfred's `src/tools/agent.ts` is a *stub*, and "autonomy" is prose. A dynamic-workflow runtime turns "spawn a sub-agent" (model-decided, unauditable) into "**run this orchestration** (hand-wired, journaled, signed)."

> **This is the single idea that unifies Alfred's whole story:** the autonomous harness *is* a built-in workflow; user tasks (review, migrate, research) are *authored* workflows; and because workflows are deterministic + journaled + signed, **"autonomy is executable and auditable" stops being a slogan and becomes the runtime.**

### 5.2 Proposed architecture — "Alfred Orchestrator v1"

**Build on what exists.** Each `agent()` is a `query()` (the existing engine) over an *isolated* message list with forced structured output. Alfred already uses **Zod** for tool schemas — reuse it for `StructuredOutput`.

```
src/orchestrator/
  runtime.ts     # injects agent()/pipeline()/parallel()/log() into a workflow fn
  agent.ts       # agent(prompt,{schema,label}) → query() w/ isolated msgs + forced Zod output
  journal.ts     # append-only .alfred/workflows/<run>/journal.jsonl  → resume + replay
  budget.ts      # token budget (reuse src/cost/tracker.ts)
  workflows/
    autonomousRun.ts   # the harness, AS a workflow (see §5.3)
    review.ts          # built-in: dimensions → find → adversarially verify
    bestOfN.ts         # built-in: N trajectories → select by VERIFY_CMD exit 0
```

- **Concurrency** capped low for a single-user CLI (e.g. 4) — P6/pragmatism, not Claude Code's 16.
- **Promote `src/tools/agent.ts`** from stub to a thin wrapper over `orchestrator/agent.ts` so the *model* can also spawn a (depth-capped, Codex `max_depth=1`-style) sub-agent, while *workflows* get the full runtime.
- **Journal = resume + replay (P3/P7):** the `journal.jsonl` is both Claude Code's resume mechanism *and* `trace-vault`'s replay tape — same artifact, two payoffs.

### 5.3 The fusion: the harness IS a workflow

This is where §5 and §7.7 (autonomy) become one thing. `alfred run` executes `workflows/autonomousRun.ts`:

```js
// pseudocode — deterministic control flow, model fills the boxes
for (const feature of pickByPriority(featureList)) {           // state machine over feature_list.json
  let attempt = 0
  while (attempt++ < feature.iteration_budget) {               // verify-fix inner loop (Aider/Devin)
    await agent(implementPrompt(feature), { tools: REAL_TOOLS })
    const verify = await bash(VERIFY_CMD)                       // init.sh → `bun test`, the objective gate
    if (verify.exitCode === 0) break
    feedback = verify.stderr                                    // failure → next turn’s input
  }
  const eval = await agent(rubricPrompt(feature, verify), { schema: RUBRIC })  // self-eval gate
  if (eval.verification === 2 && verify.exitCode === 0) markPassing(feature, sign(episode))
  else if (consecutiveBlocked++ >= 2) break                    // stop condition
}
```

- **best-of-N** = wrap the inner attempt in `parallel()` across Alfred's two providers, select the trajectory whose `VERIFY_CMD` exits 0 (OpenHands-style inference-time scaling, but with an *objective* reward — no trained critic needed).
- Every step appends to the **signed ledger** (P7): `{feature, toolHashes, verifyExit, rubric, cost, gitSha}`. That ledger is the `provenant`-style Proof Receipt for an autonomous run.

### 5.4 综合评估 — workflows

| Idea (Claude Code dynamic workflow) | Verdict | Why |
|---|---|---|
| `agent()/pipeline()/parallel()` deterministic runtime | **Adopt** | The connective tissue for auditable autonomy; small build on existing engine. |
| Structured-output schemas | **Adopt** | Alfred already has Zod; near-free. |
| Journal → resume + replay | **Adopt** | Doubles as `trace-vault` replay tape; enables `--resume`. |
| Token budget scaling | **Adopt (simple)** | Reuse `CostTracker`; cap concurrency low. |
| Harness-as-a-workflow | **Adopt — the flagship** | Unifies the entire narrative; makes the headline claim literally run. |
| best-of-N across providers, objective reward | **Adopt (P2)** | Cheap, honest reward (exit code) vs. LLM judge. |
| A full general-purpose workflow DSL / marketplace | **Defer** | Ship 2-3 built-in workflows first; expose authoring later. |
| 16-wide concurrency, worktree isolation | **Adapt down** | Single-user CLI: low concurrency; git-stash checkpoints instead of worktrees. |

---

## 6. Four more best-of-breed domains (code intelligence · agent security · observability · model routing)

Beyond memory (§4) and workflows (§5), four more domains are worth taking best-of-breed from — each fills a *real* Alfred gap, and each reinforces the "verifiable / reliable / auditable" thesis rather than chasing cosmetic parity. They are **cross-cutting** (they thread through every layer of §3).

### 6.1 Code intelligence & repo understanding

**Best practice.** Two complementary layers. (1) A **repo map** for whole-repo structural awareness without dumping files — Aider parses each file with **tree-sitter**, runs `.scm` tag queries for `def`/`ref` tags, builds a **directed graph** (files = nodes, edges = "A references a symbol defined in B"), and **PageRanks** it into a fixed **token budget**, weighting edges heuristically (10× identifiers in the user's message, 50× refs from files already in chat, 0.1× private/ubiquitous names) [[CI1]](#ci1). (2) **Semantic precision on demand** via the **Language Server Protocol** — go-to-definition, find-references, hover types, call hierarchy, and **post-edit diagnostics**; finding all call sites is ~50 ms via LSP vs tens of seconds of recursive grep [[CI2]](#ci2). Tree-sitter alone is syntax-only but fast and error-tolerant; a tree-sitter **parse check after every edit** catches broken syntax before tests run, and agent-native wrappers (Kiro, the LSAP protocol) turn raw LSP into high-level tools [[CI3]](#ci3). Tellingly, **Hermes Agent is adding both** (repo-map #535, LSP post-edit diagnostics #516) — convergence again [[CI4]](#ci4).

**Alfred's gap.** Alfred has **only `glob` + `grep`** (`src/tools/glob.ts`, `src/tools/grep.ts`) — pure text search, zero structural or semantic awareness. It can't answer "where is this symbol defined / used," can't surface types, and `fileEdit` can write **syntactically broken** code caught only later by `bun test` (if a test even covers it). On a large repo the model greps blindly and burns turns.

**Recommendation.** (a) **Repo map** — new `src/context/repomap.ts` (tree-sitter via `web-tree-sitter` + PageRank into a token budget), injected adjacent to memory Core (§4). (b) **Post-edit tree-sitter syntax check** in `src/tools/fileEdit.ts` — reject an edit that doesn't parse (cheap; catches a whole class of failures before the verify loop). (c) **LSP client** — new `src/tools/lsp/` exposing `definition`/`references`/`hover`/`diagnostics` as tools + a diagnostics signal in the harness verify loop. **Verdict: Adopt repo-map (P1, M) + post-edit parse check (P0-adjacent, S); LSP client (P2, M→L).** Differentiation: **correctness** — far fewer hallucinated edits.

### 6.2 Agent-layer security: prompt-injection & exfiltration defense

**Best practice.** Distinct from OS sandboxing (§7.3 bounds *what the process can do*); this bounds *what untrusted content can make the agent do*. The threat is Simon Willison's **lethal trifecta** — **private data + untrusted content + an exfiltration channel** in one context; any two are safe, all three is exploitable [[S1]](#s1). Because LLMs **cannot reliably separate trusted from injected instructions**, the defenses are architectural: **dual-LLM** (a privileged P-LLM with tools orchestrates a quarantined Q-LLM that reads untrusted content but has *no* tools); **CaMeL** (Google DeepMind — the privileged model emits a restricted-Python plan and a **deterministic policy engine outside the model** decides what runs, tracking taint/capabilities); and **blast-radius reduction** — egress allow-lists, secret redaction, treating *every* web/MCP/bash output as untrusted [[S2]](#s2)[[S3]](#s3). The killer fact: **no mainstream harness — Claude Code, Cursor, Hermes, Copilot, Gemini CLI — ships these yet** [[S2]](#s2).

**Alfred's gap.** Alfred has the **full lethal trifecta wide open**: it reads private repo data, ingests **untrusted content** (`src/tools/webFetch.ts` fetches arbitrary URLs; the MCP bridge pipes arbitrary server output straight into context), and has **exfiltration channels** (no-egress `bash`/`webFetch`). With `mode:"bypass"` hardcoded (review), a single poisoned web page or MCP response can tell Alfred to read `.env` and `curl` it out — no isolation, no taint, no egress gate; tool outputs are concatenated verbatim with no provenance.

**Recommendation.** (a) **Taint + fence** — new `src/security/taint.ts`: mark `webFetch`/MCP/`bash`-stdout as untrusted in `ToolUseContext` and wrap it in a clearly-labelled "untrusted data — not instructions" block; longer-term route it through a **quarantined sub-agent** (the §5 orchestrator makes dual-LLM *natural*). (b) **Egress allow-list** — new `src/security/egress.ts`, enforced in `webFetch.ts` + the sandbox. (c) **Secret redaction** — new `src/security/redact.ts`: scrub `.env`/key-shaped strings from context *and* the run ledger. **Verdict: Adopt taint+fence + egress + redaction (P1, M); dual-LLM quarantine (P2, builds on §5).** Differentiation: **highest and most on-brand** — "reliability you can audit" includes "can't be hijacked," and *no competitor ships it.*

### 6.3 Observability, telemetry & evals

**Best practice.** Treat the agent like production software: emit **OpenTelemetry GenAI semantic-convention spans** — `gen_ai` spans for model calls, **agent invocations**, **workflow** spans, and **`execute_tool {gen_ai.tool.name}`**, with token/cost/session attributes [[O1]](#o1) — so any backend (Datadog/Honeycomb/Langfuse/LangSmith) renders the trajectory without bespoke code [[O2]](#o2). Layer an **eval harness** that replays recorded trajectories and asserts regressions. This is the difference between "the agent did something" and "here is the exact, queryable, replayable trace of what it did and what it cost."

**Alfred's gap.** Alfred's `CostTracker` (`src/cost/tracker.ts`) is **never consulted** (review), and there is **no structured tracing** at all — events are `console.log`/chalk strings (`src/repl.ts`). No span model, no trajectory export, no eval harness. Yet Alfred's whole thesis is *provable* reliability — currently unprovable because nothing is instrumented.

**Recommendation.** (a) **OTel GenAI spans** — new `src/telemetry/otel.ts`: wrap each `provider.chat`, tool call, and orchestrator agent/workflow in a `gen_ai.*` span; export via OTLP (opt-in). (b) **The run ledger IS the span tree** — emit the §5.3 signed ledger as OTel spans, so the HMAC receipt and the observability trace are *one artifact* (ties `trace-vault`). (c) **Eval harness** — new `src/eval/`: replay recorded sessions, assert tool-call / verify-exit regressions. **Verdict: Adopt OTel spans + ledger-as-spans (P2, M); eval harness (P3).** Differentiation: **on-brand** — makes "provable reliability" literally exportable and standard.

### 6.4 Model routing & the architect–editor split

**Best practice.** Don't use one model for everything. The proven coding-agent pattern is **architect/editor separation** — a strong reasoning model **plans** the change in prose; a fast, cheap model **applies** it as precise edits; Aider reports this decomposition produces **SOTA** edit-benchmark results [[R1]](#r1). Generalize to **tiered routing** (Claude Code: Opus plan / Sonnet code / Haiku sub-agents) and **fallback chains** (retry on a different provider on overload). The model is chosen per *sub-task*, not per session.

**Alfred's gap.** Alfred has a clean **provider abstraction** (`src/providers/`) but the loop uses **one `config.model` for everything** (`src/repl.ts` `resolveConfig`, default `glm-5.1`) — expensive reasoning and cheap mechanical edits pay the same model; no architect/editor split, no per-role routing, no fallback. This contradicts the repo's own `CLAUDE.md` Rule 6 (token budget).

**Recommendation.** (a) **Role-based model map** — extend `QueryConfig` (`src/query/types.ts`) + `src/config/manager.ts` with `{architect, editor, subagent}` slots. (b) **Architect/editor in the harness** (§5.3) — the implement step runs the architect model to produce a plan, the editor model to turn it into `fileEdit` calls (a natural orchestrator fit). (c) **Provider fallback** in the retry layer (review R1.1) — fail over to the other provider on `overloaded`. **Verdict: Adopt role map + fallback (P1, M); architect/editor in harness (P2, builds on §5).** Differentiation: **correctness + cost** — a cheap, well-known win.

---

## 7. The rest of the best-of-breed spine (condensed)

These are detailed in `alfred-vs-the-field.md`; here only the *source of the "best" idea* + the Alfred attachment point. They are prerequisites or parity work that the headline imports sit on.

| # | Dimension | Best-of-breed idea (source) | Alfred attachment |
|---|---|---|---|
| 7.1 | System prompt | Per-model, composable fragments; quantified verbosity; ALL-CAPS git-NEVER; `AGENTS.md` discovery (Codex/Claude/Gemini) | `src/context/index.ts`, `src/context/claudemd.ts` — **and wire it in** (`src/repl.ts`, the P0 that unblocks memory injection) |
| 7.2 | Tool edit | Content-anchored fuzzy match ladder + read-before-write/mtime (Codex `seek_sequence`, Claude Code) | `src/tools/fileEdit.ts`, `src/tools/lib/seekSequence.ts` |
| 7.3 | Permissions/sandbox | Two orthogonal axes: OS sandbox × approval policy; DENY beats bypass; scary flag refused as root (Codex Seatbelt/Landlock, Claude `/sandbox`) | `src/permissions/types.ts`, new `src/sandbox/`, `src/repl.ts` (stop hardcoding `bypass`) |
| 7.4 | Context/cache | `cache_control` on stable prefix; real `count_tokens`; user-boundary LLM compaction; **context editing** (Anthropic) | `src/providers/anthropic.ts`, `src/compact/engine.ts` |
| 7.5 | Hooks | `PreToolUse/PostToolUse/…` with the **exit-2-blocks** contract (Claude Code/Codex) | new `src/hooks/`, dispatch in `src/query/engine.ts` |
| 7.6 | MCP/skills | Faithful MCP (real schema, derived read-only); **3-level skills** = procedural memory w/ progressive disclosure (Hermes ships 91; Claude skills) | `src/mcp/types.ts`, `src/skills/loader.ts` — **and load them** (`bootstrapExtensions`) |
| 7.7 | Autonomy | Headless NDJSON; typed exit codes; checkpoint/rollback (shadow-git); objective verify gate; anti-gaming eval (Codex `exec`, Gemini exit-53, Aider `--auto-test`, SWE-bench Verified) | new `src/harness/*`, `src/index.ts` — **realized as the §5.3 workflow** |

**Note the dependency Hermes makes explicit:** memory + skills + the self-improving loop only *work* once the prompt is wired (7.1) and the harness is executable (7.7/§5). That ordering drives §9.

---

## 8. 综合评估 master table — the whole proposal at a glance

Effort: **S** ≈ hours · **M** ≈ 1-2 days · **L** ≈ multi-day. "Differentiation" = does it set Alfred apart, or just reach parity?

| Subsystem | Adopt from | Verdict | Effort | Differentiation |
|---|---|---|---|---|
| **Memory v2 (file-first tiered)** | Hermes + your CLAUDE.md | **Adopt — core** | L | High (curated+verifiable) |
| Memory provider seam | Hermes contract | Adopt (iface only) | M | Med |
| Episodic records → ledger | Letta + provenant | **Adopt** | M | **High** |
| Contradiction/staleness GC | Holographic + Hermes | Adopt | M | Med |
| Context editing | Anthropic | Adopt | M | Parity |
| Mem0/Zep backends | — | Adapt (later) / Reject as default | — | Low |
| **Dynamic workflow runtime** | Claude Code | **Adopt** | L | **High** |
| Harness-as-workflow | Claude Code + Alfred spec | **Adopt — flagship** | M (on runtime) | **Highest** |
| best-of-N objective reward | OpenHands | Adopt (P2) | M | High |
| Signed run ledger | provenant/trace-vault | **Adopt** | M | **Highest** |
| **Code intelligence (repo-map + LSP)** | Aider / Kiro / LSP | **Adopt** | M→L | **High (correctness)** |
| **Agent-layer security (lethal trifecta)** | Willison / CaMeL / dual-LLM | **Adopt** | M | **Highest (no one ships it)** |
| **OTel observability + ledger-as-spans** | OTel GenAI / Langfuse | **Adopt** | M | High (on-brand) |
| **Architect/editor model routing** | Aider / Claude Code | **Adopt** | M | High ROI |
| System prompt wired+fleshed | Codex/Claude/Gemini | Adopt (P0) | S→M | Parity (unblocks all) |
| Fuzzy edit + mtime | Codex/Claude | Adopt (P0) | M | Parity |
| OS sandbox + approval axes | Codex/Claude | Adopt (P0/P1) | L | Parity (table stakes) |
| Prompt cache + real tokenizer | Anthropic | Adopt (P1) | M | Parity (cost) |
| Hooks (exit-2-blocks) | Claude/Codex | Adopt (P1) | L | Parity |
| Faithful MCP + 3-level skills | Gemini/Claude/Hermes | Adopt (P1/P2) | M | Med |
| Soul/personality file | Hermes | Adapt (optional) | S | Low |
| Crons | Hermes | Map→harness | — | — |
| Workflow DSL/marketplace | Claude Code | Defer | — | — |

---

## 9. Phased rollout (dependency-ordered)

The ordering is forced by one fact (Hermes/§7 note): **memory and orchestration both depend on the system prompt being wired and the loop being robust.** So the P0 review fixes are Phase 0 here.

**Phase 0 — Foundations (the review's P0, ~1 week).** Wire the system prompt (`src/repl.ts`) ← *unblocks memory injection*; retry/backoff; stop hardcoding `bypass` + kill-list + path jail; fuzzy edit + mtime; real invoked compaction; `maxTokens`; typed terminal status; **post-edit tree-sitter syntax check** (§6.1, cheap correctness). *Gate:* `alfred -p "edit X"` runs with a real prompt, survives a 429, won't `rm -rf`, won't silently overflow, won't accept unparseable edits.

**Phase 1 — Memory v2 + correctness/security/cost (§4, §6, ~1-2 weeks).** `LocalFileProvider` + `.alfred/memory/` layout; 4-stage flow; episode records; `memoryTool` CRUD; contradiction/staleness GC; context editing. **Plus the high-urgency §6 items:** repo map (§6.1), taint+fence + egress allow-list + secret redaction (§6.2 — urgent given the open trifecta), architect/editor role map + provider fallback (§6.4). *Gate:* a fact taught in session A is recalled in session B; a poisoned web page can't exfiltrate `.env`; mechanical edits run on the cheap model.

**Phase 2 — Orchestrator + Harness fusion + observability (§5, §6.3, ~1-2 weeks).** Orchestrator runtime; promote `src/tools/agent.ts`; `workflows/autonomousRun.ts` = feature_list state machine + verify-fix loop + rubric gate; shadow-git checkpoint/rollback; HMAC signed ledger emitted as **OTel spans** (§6.3); architect/editor + dual-LLM quarantine on the orchestrator (§6.2/§6.4). *Gate:* `alfred run` drives `feature_list.json` to green, refuses `passing` without a captured exit-0, emits a replayable signed ledger that opens in any OTel viewer.

**Phase 3 — Parity polish + extensibility (§7, §6 tail, ongoing).** Streaming; prompt caching + real tokenizer; OS sandbox; hooks engine; faithful MCP; 3-level skills; best-of-N; **LSP client** (§6.1); **eval harness** (§6.3). *Gate:* reviewers take it seriously next to Codex/Gemini.

**Phase 4 — Flagship demo (moonshot).** *Alfred-Bench:* Alfred rebuilds its own `feature_list.json` from an empty `src/` under held-out verification (tests withheld from the model, run only by the harness, dual FAIL→PASS / PASS→PASS condition), producing a signed, replayable bootstrap trajectory. "Watch it rebuild itself under a gate it can't cheat."

---

## 10. Risks & open questions

- **Curation quality vs. noise.** Agent-curated memory can hoard junk. *Mitigation:* token-budgeted Core, contradiction/staleness GC, and a `memory` review command. (Hermes' own warning is the design driver here.)
- **Cache vs. dynamic memory tension.** Prefetched memory changes the prefix and can hurt prompt-cache hit-rate. *Mitigation:* Core (stable) is cached; prefetch goes in an *append-only* ephemeral block evicted by context-editing — never prepended.
- **Determinism of workflows with non-deterministic models.** The *orchestration* is deterministic; model outputs are not. *Mitigation:* `trace-vault`-style replay asserts the orchestrator is deterministic *given fixed model outputs* — separating "reproducible run" from "faithful self-report."
- **Security is never "done."** Taint+fence reduces but does not eliminate prompt-injection risk (no harness has solved it). *Mitigation:* defense-in-depth (egress allow-list + sandbox + quarantined sub-agent), and be honest in docs about residual risk rather than claiming immunity.
- **Scope creep.** This is a lot. *Mitigation:* Phases 0-1 alone already make Alfred a credible, honest, *safe* agent; 2+ are the differentiation and can be staged.
- **Provider build cost.** Designing the memory provider seam but only shipping the local backend risks an unused abstraction. *Mitigation:* keep the interface tiny (8 methods); only generalize when the second backend is actually wanted.

---

## 11. Sources

<a id="h1"></a>[H1] Hermes Agent — Memory Providers (Nous Research, official docs): https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers
<a id="h2"></a>[H2] Hermes Agent — 5-Pillar Architecture (memory/skills/soul/crons/self-improving): https://www.mindstudio.ai/blog/hermes-agent-5-pillar-architecture-memory-skills-soul-crons · memory deep-dive: https://www.glukhov.org/ai-systems/hermes/hermes-agent-memory-system/
<a id="m1"></a>[M1] MemGPT → Letta (OS-tiered agent memory; core/recall/archival; episodic coherence): https://www.letta.com/ · MemGPT paper: https://arxiv.org/abs/2310.08560
<a id="a1"></a>[A1] Anthropic — Memory tool (client-side file directory, `memory_20250818`): https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
<a id="a2"></a>[A2] Anthropic — Context editing & context management (−84% tokens, 100-turn eval): https://www.anthropic.com/news/context-management · https://platform.claude.com/docs/en/build-with-claude/context-editing
<a id="f1"></a>[F1] Agent memory landscape 2026 — Letta vs Zep vs Mem0 vs LangMem/Cognee: https://agentmarketcap.ai/blog/2026/04/10/agent-memory-vendor-landscape-2026-letta-zep-mem0-langmem · Mem0: https://github.com/mem0ai/mem0 · Zep/Graphiti: https://github.com/getzep/graphiti
<a id="f2"></a>[F2] MemOS — self-evolving memory OS (35% token savings): https://github.com/MemTensor/MemOS
<a id="f3"></a>[F3] Generative Agents (reflection as memory synthesis): https://arxiv.org/abs/2304.03442
<a id="c1"></a>[C1] Claude Code dynamic workflow / Agent SDK subagents & orchestration: https://code.claude.com/docs/en/agent-sdk/subagents · streaming: https://code.claude.com/docs/en/agent-sdk/streaming-output
<a id="c2"></a>[C2] OpenHands — inference-time scaling + objective selection: https://www.openhands.dev/blog/sota-on-swe-bench-verified-with-inference-time-scaling-and-critic-model
<a id="c3"></a>[C3] Aider — lint/test self-healing loop (objective verify gate): https://aider.chat/docs/usage/lint-test.html
<a id="c4"></a>[C4] SWE-bench Verified (anti-gaming dual pass-condition): https://github.com/SWE-bench/SWE-bench
<a id="ci1"></a>[CI1] Aider — repo map (tree-sitter + PageRank into a token budget): https://aider.chat/2023/10/22/repomap.html · https://aider.chat/docs/repomap.html
<a id="ci2"></a>[CI2] LSP for coding agents (IDE-level intelligence, ~50 ms call-site lookup); Kiro CLI code intelligence: https://kiro.dev/docs/cli/code-intelligence/ · the/experts "Give your AI agent eyes": https://tech-talk.the-experts.nl/give-your-ai-coding-agent-eyes-how-lsp-integration-transform-coding-agents-4ccae8444929
<a id="ci3"></a>[CI3] LSAP (Language Server Agent Protocol): https://github.com/lsp-client/LSAP · tree-sitter vs LSP: https://automadocs.com/blog/tree-sitter-vs-lsp-code-analysis
<a id="ci4"></a>[CI4] Hermes Agent adding repo-map + LSP: https://github.com/NousResearch/hermes-agent/issues/535 · https://github.com/NousResearch/hermes-agent/issues/516
<a id="s1"></a>[S1] Simon Willison — the lethal trifecta (private data + untrusted content + exfiltration): https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
<a id="s2"></a>[S2] Dual-LLM + CaMeL prompt-injection defenses (and the gap: no mainstream harness ships them): https://afine.com/llm-security-prompt-injection-camel · Willison "design patterns": https://simonwillison.net/2025/Apr/11/camel/
<a id="s3"></a>[S3] Sophos — blast-radius reduction in AI agent deployments: https://www.sophos.com/en-us/blog/inside-the-lethal-trifecta-blast-radius-reduction-in-ai-agent-deployments
<a id="o1"></a>[O1] OpenTelemetry — GenAI agent & framework spans (semantic conventions): https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/
<a id="o2"></a>[O2] Datadog — native OTel GenAI semantic-convention support: https://www.datadoghq.com/blog/llm-otel-semantic-convention/
<a id="r1"></a>[R1] Aider — architect/editor mode (strong model plans, fast model edits; SOTA edit benchmark): https://aider.chat/2024/09/26/architect.html · https://aider.chat/docs/usage/modes.html

> Full per-dimension industry citations (50 sources) live in the companion `alfred-vs-the-field.md` §6.
