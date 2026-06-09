# Alfred vs. the Field: How to Write a Coding Agent

> **语言 / Language:** 本文档为英文正文(回溯性评审证据);前瞻设计文档为双语,见 [`improvement-proposal.zh-CN.md`](./improvement-proposal.zh-CN.md) 与 [`adr/`](./adr/)。
>
> **中文导航摘要:** 这是对 `BeamusWayne/Alfred` 的代码级评审,对标 Codex CLI / Gemini CLI / Claude Code——7 个维度、54 条建议、50 个来源。核心结论:Alfred 骨架干净,但有「**库写好了却没接线**」的通病——系统提示、streaming、压缩、cost 追踪、MCP/skills/plugins loader、整套自治 harness 都存在却无运行时调用方;agent 裸跑无系统提示、`mode:"bypass"` 硬编码、无 retry/缓存/沙箱。最高杠杆 **P0**:接系统提示进 loop、retry-with-backoff、停掉 bypass + kill-list、模糊编辑 + mtime、真压缩。各章:**§1** 执行摘要 · **§2** 七维(agent loop / 系统提示 / 工具 / 权限沙箱 / 上下文 / 可扩展 / 自治)· **§3** 打分表 · **§4** P0/P1/P2 路线图 · **§5** 差异化头脑风暴 · **§6** 来源。

*A code-grounded review of `BeamusWayne/Alfred` against OpenAI Codex CLI, Google Gemini CLI, and Anthropic Claude Code — with the highest-leverage moves to go from "clone with a great spec" to "verifiable autonomous coding agent." Date: 2026-06-05.*

> Every gap and recommendation below was checked against the actual source tree at the time of writing (`src/query/engine.ts`, `src/providers/anthropic.ts`, `src/repl.ts`, `src/context/index.ts`, `src/compact/engine.ts`, `src/tools/*`, `src/permissions/types.ts`, `src/tasks/store.ts`, `init.sh`, `feature_list.json`). Severities are honest, not generous.

::: warning Historical review — most gaps are now resolved
This is a point-in-time review (2026-06-05). Since then the P0/P1 recommendations
were implemented and a full security/correctness audit closed 31 findings, so the
**"Alfred's gap" subsections below are largely out of date** — e.g. compaction now
LLM-summarises and is invoked by the loop, the system prompt + memory are injected,
prompt caching and `count_tokens` are wired, streaming exists for all three
providers, and the autonomous harness runs. Read the gap lists as the *original
diagnosis*, not the current state; the **"Best practice" and "Top recommendations"
sections remain a useful reference**. See the git history and current `src/` for what shipped.
:::

---

## 1. Executive summary

Alfred is a clean, well-factored TypeScript/Bun coding-agent skeleton (~3,456 LOC in `src`, 20 test files) that is the structural peer of Gemini CLI. Its bones are genuinely good: a `buildTool()` factory with capability flags (`isReadOnly`/`isConcurrencySafe`/`isDestructive`), an `AsyncGenerator query()` loop whose stop condition (`response.stopReason !== "tool_use"`) matches Claude Code's, a declarative parallel/serial tool partition, and — uniquely — a richer *autonomous-harness spec* (`CLAUDE.md`, `autonomous-loop.md`, `evaluator-rubric.md`, `feature_list.json` with an `autonomous_config` block) than any of the three reference CLIs ship.

The problem is a consistent **"library built, never wired"** pattern: the most important subsystems exist as code that nothing at runtime calls, and the headline autonomy capability exists only as prose. Verified facts:

- **Alfred runs with no system prompt.** `src/repl.ts:resolveConfig` (lines 49–61) never sets `systemPrompt`; `buildSystemPrompt`/`buildSystemContext` have zero callers outside `tests/context.test.ts`. So `config.systemPrompt` is `undefined` all the way to `system: config.systemPrompt` in `src/providers/anthropic.ts:112`. No identity, tone, tool-policy, git-safety, or CLAUDE.md guidance reaches the model.
- **The running agent hardcodes `mode: "bypass"`** (`src/repl.ts:69`) and there is **no OS sandbox** (zero matches for seatbelt/landlock/bwrap/seccomp in `src`). Out of the box Alfred executes any model-chosen shell command with no approval and no isolation — strictly below Aider's posture.
- **No retry/backoff** (zero matches in `src`): one 429/socket-reset on turn 30 discards the whole run (`src/query/engine.ts:45–48`).
- **No prompt caching** (zero `cache_control` matches) and **token counting is `Math.ceil(text.length / 4)`** in both providers and `compact/engine.ts` — wildly wrong for Alfred's own Chinese `CLAUDE.md`.
- **The autonomous harness is 100% prose**: `grep -rniE 'feature_list|autonomous|init.sh|evaluator-rubric' src` returns nothing. The verify-fix loop, the 5-iteration cap, `max_consecutive_blocked=2`, `loop_detection_threshold=0.8`, and the rubric gate are instructions for an external operator, not runtime machinery.
- **Streaming, compaction, cost tracking, MCP/skills/plugins loaders, and the subagent tool are all implemented-but-dead** (never called from `src/repl.ts` or `src/query/engine.ts`). `feature_list.json` marks F10 "passing" with the literal evidence string `"webSearch placeholder, agentTool placeholder"`.

**The five highest-leverage moves** (each detailed in §2 / §4):

1. **Wire the system prompt into the loop** (`src/repl.ts`) — one change resurrects the entire dead `src/context/` subsystem. *(P0, S)*
2. **Add retry-with-backoff around `provider.chat()`** preferring server `Retry-After` (`src/query/engine.ts`, new `src/query/retry.ts`) — stops one network blip from killing a long run. *(P0, M)*
3. **Stop hardcoding `bypass`; default to "ask," gate full-auto behind a scary flag, and add an OS sandbox for bash** (`src/repl.ts`, `src/index.ts`, new `src/sandbox/`). *(P0, S→L)*
4. **Make the autonomous harness executable** — a real `alfred run` that reads `feature_list.json` as a state machine and runs an Aider/Devin verify-fix inner loop against `init.sh`'s `bun test` exit code (new `src/harness/`). *(P2 differentiator, but it is the repo's reason to exist.)*
5. **Add prompt caching + a real tokenizer** (`src/providers/anthropic.ts`) — the two biggest avoidable-cost levers for a Claude-Code-style clone. *(P1, M)*

Alfred's distinctive opportunity is **not** to out-clone Codex on streaming, but to become the one CLI where *autonomy is enforced and auditable* — slotting beside the owner's `trace-vault` and `provenant` as the coding-agent pillar of a "provable agent reliability" portfolio.

---

## 2. How to write a coding agent — the 7 dimensions

### Dimension 1 — Agent loop, control flow & orchestration

**Best practice.** The loop is enforced runtime machinery: an outer loop that supports mid-run input steering and an inner turn loop whose continuation is driven by "any tool call OR server `end_turn:false` OR queued input." Transient model/stream failures get **retry with exponential backoff that prefers the server `Retry-After`** (Codex: `stream_max_retries=5`, `request_max_retries=4`, `200ms·2^(n-1)·jitter`, with `ContextWindowExceeded`/`UsageLimitReached` bypassing retry [[2]](#s2)[[3]](#s3)). Tools overlap with streaming (Codex `FuturesOrdered`; Gemini's `CoreToolScheduler` runs ready calls via `Promise.all(...signal)` through a `Validating→AwaitingApproval→Scheduled→Executing` state machine [[4]](#s4)). Terminal states are **typed** (Claude Code returns `success`/`error_max_turns`/`error_max_budget_usd`/`error_during_execution` so a wrapper can tell "resume me" from "fatal" [[1]](#s1)). Mid-turn auto-compaction `continue`s instead of overflowing (Codex `CompactionPhase::MidTurn` [[2]](#s2)). The whole turn runs under a cancellation token for clean Esc. Gemini adds `checkNextSpeaker()` for dangling turns [[5]](#s5) and a `loopDetectionService`; OpenHands halts after 4 identical / 6+ alternating action-observation pairs [[6]](#s6).

**Alfred's gap.** The loop in `src/query/engine.ts` is correct in spirit but first-generation:
- **No retry/backoff (CRITICAL).** `engine.ts:43–48` wraps `provider.chat()` in a single try/catch that yields one `{type:"error"}` and `return`s on *any* throw. A 429/500/socket-reset discards all completed work.
- **Never streams (HIGH).** `engine.ts:44` calls the blocking `provider.chat()`; text is yielded only at `engine.ts:53–57` after the full response. `AnthropicProvider.stream()` (`anthropic.ts:125–183`, including `tool_use_delta` buffering) and the OpenAI equivalent are fully written but have zero callers — `src/repl.ts:142 runQueryStreaming` just relabels post-hoc events.
- **One overloaded error type + no budget cap (HIGH).** Max-turns (`engine.ts:88`) emits the *same* `{type:"error"}` as a provider crash (`engine.ts:46`); a caller cannot distinguish "raise the cap" from "abort." The `CostTracker` in `src/cost/tracker.ts` is never consulted.
- **No cancellation (HIGH).** `ToolUseContext.abortController` (`src/repl.ts:65`) is listened to by `bash.ts:46`/`webFetch.ts:20` but `.abort()` is never called, and `provider.chat()` is passed no signal — Esc cannot interrupt an in-flight round-trip.
- **`ask` is a dead-end (MEDIUM).** `engine.ts:138–140` feeds the model a fake error string instead of prompting a human.
- **No stuck/loop detection (MEDIUM); no next-speaker recovery (LOW).** A model can burn all 50 turns re-running a failing command; a dangling prose turn ends the run (note the default model is `glm-5.1`, `repl.ts:52`).

**Top recommendations.**
- **R1.1 (P0):** Add `src/query/retry.ts` and wrap `provider.chat()` in `engine.ts`: retry only `429/500/502/503/ECONNRESET`, `200·2^(n-1)·jitter` capped at ~5, **prefer parsed `Retry-After`**, bypass `context_length_exceeded`/`usage_limit`. Surface a `retrying` event.
- **R1.2 (P1):** Replace the `provider.chat()` call with the existing `provider.stream()` (activates ~130 lines of dead code), mapping `text_delta → {type:"text"}`; forward deltas through `src/repl.ts:142`.
- **R1.3 (P0):** Add a typed terminal status to `QueryState`/`QueryEvent` (`src/query/types.ts`) — `success | max_turns | max_budget | provider_error | stuck` — and wire `CostTracker` for a `maxBudgetUsd` break (`engine.ts`).
- **R1.4 (P1):** Thread a per-turn `AbortController` (child of `repl.ts:65`) into `provider.chat()`/`stream()` (extend `ProviderConfig` with `signal`) and bind Esc in the Ink TUI.

---

### Dimension 2 — System prompt & instruction/memory-file design

**Best practice.** The system prompt is a production-engineered, conditionally-assembled mosaic of many small named fragments gated on env/state, versioned per model, with override/inspection hooks (Claude Code `--append-system-prompt` [[7]](#s7); Codex `experimental_instructions_file` + per-model `gpt_5_codex_prompt.md` [[9]](#s9); Gemini `GEMINI_SYSTEM_MD`/`GEMINI_WRITE_SYSTEM_MD` [[10]](#s10)). It carries a **quantified verbosity budget** (Gemini "<3 lines" [[10]](#s10)), an explicit tool-use policy (prefer dedicated Read/Edit/Grep over `bash cat/sed`, prefer `rg`, parallelize independent calls, never two Edits to one file/turn), **ALL-CAPS git NEVER rules** backed by sandbox (Codex: "NEVER `git reset --hard`/`checkout --` unless requested" [[9]](#s9)), a `file_path:line` citation format, and a defensive-security refusal posture. Instruction files are a layered, concatenated hierarchy where the most-specific file loads **last** and wins, converging on **AGENTS.md** as the cross-tool standard [[8]](#s8), delivered as *context, not enforced* (Claude Code injects CLAUDE.md as a user message after the system prompt [[7]](#s7)). Anti-over-engineering is targeted explicitly ("three similar lines > premature abstraction").

**Alfred's gap.** A competent builder that never runs:
- **System prompt is dead code → Alfred ships an empty prompt (CRITICAL).** `src/repl.ts:resolveConfig` (49–61) never sets `systemPrompt`; verified zero callers of `buildSystemPrompt`/`buildSystemContext` outside `tests/context.test.ts`. `undefined` flows to `anthropic.ts:112`.
- **Even when built, the prompt has no behavioral content (CRITICAL).** `src/context/index.ts:25–43` emits only identity + cwd + date + optional CLAUDE.md + git — no verbosity budget, no tool policy, no git NEVER rules, no citation format, no security posture.
- **AGENTS.md is never discovered (HIGH).** `src/context/claudemd.ts` looks only for `CLAUDE.md`/`.claude/CLAUDE.md` (verified `grep AGENTS src` → nothing), even though a rich `AGENTS.md` harness spec sits at repo root — so Alfred can't even self-host on its own instructions.
- **`max_tokens` hardcoded to 4096 (HIGH).** `anthropic.ts:110,133` use `config.maxTokens ?? 4096`, but `QueryConfig` has no `maxTokens` field and `engine.ts:26–31` never threads it, so the `config/manager.ts` default is orphaned — long edits silently truncate.
- **No override/inspection hook (MEDIUM); CLAUDE.md spliced into system text rather than fenced as non-enforced context (LOW)** — note `src/memory/index.ts` already fences recalled memory correctly; the same discipline isn't applied to instruction files.

**Top recommendations.**
- **R2.1 (P0):** In `src/repl.ts` call `await buildSystemContext(process.cwd())` + `buildSystemPrompt(ctx)` and assign to `config.systemPrompt`. `engine.ts:30` already forwards it. *This one change is the prerequisite for every other prompt improvement.*
- **R2.2 (P1):** Flesh out `buildSystemPrompt` in `src/context/index.ts` with small composable constants — verbosity budget, doing-vs-explaining, anti-over-engineering, a tool policy that **mirrors `partitionToolCalls`**, ALL-CAPS git rules, `file_path:line` citations, security posture.
- **R2.3 (P1):** Add `AGENTS.md` to `CLAUDE_MD_NAMES` in `src/context/claudemd.ts` (keep the existing `.reverse()` so cwd wins).
- **R2.4 (P0):** Thread `maxTokens` end-to-end: add to `QueryConfig` (`src/query/types.ts`), copy in `engine.ts:26–31`, read from env/config in `resolveConfig`.

---

### Dimension 3 — Tool design (edit strategy, search, bash, web)

**Best practice.** **Edit by content-anchoring, never line numbers**, behind a **multi-pass fuzzy matcher** (Codex `seek_sequence.rs`: exact → `trim_end` → `trim` → Unicode-normalize with a length guard [[11]](#s11); Aider measured **9× more errors** without flexibility [[12]](#s12); Cline's strict exact-match is the documented anti-pattern). **Read-before-write with an mtime freshness check runs first** so a stale edit is a clean retryable error, not silent corruption (Claude Code [[14]](#s14)). Ship the edit tool as a grammar-constrained **freeform** channel (Codex named `apply_patch` cut failure **35%** [[13]](#s13)) and support atomic multi-file patches. Search on **ripgrep** with output-mode split (files/content/count) and gitignore-awareness. **Token economy:** truncate bash output to a budget but **spill the full result to a file** the model can re-grep (Claude Code: 30k cap → session file [[14]](#s14)) — never a hard overflow. Two-layer bash safety (prefix-allowlist + chain-splitting) is **UX-only**; the real boundary is an OS sandbox [[15]](#s15). Web splits cheap search (links only) from expensive fetch (HTML→Markdown extract-by-prompt, HTTPS upgrade, cross-host-redirect hand-back for SSRF safety, per-URL cache, domain gating).

**Alfred's gap.** Good `buildTool()` contract, first-generation behaviors:
- **`fileEdit` has no fuzzy matching (CRITICAL).** `src/tools/fileEdit.ts:35` uses `content.includes(old_string)` then `.replace`/`.split().join()`; any smart quote or indentation drift fails.
- **No read-before-write / mtime check; `readFileState` is dead state (CRITICAL).** `ToolUseContext.readFileState` is `Map<string,string>` (value is content only, no mtime — `tools/types.ts:40`), written by `fileRead.ts:40`, read by nothing. `fileEdit`/`fileWrite` never consult it and never `stat()`, so the model can edit a file it never read and an external write is silently clobbered.
- **No path containment (HIGH).** All file tools do `path.resolve(context.workingDir, input.path)` with no jail; `/etc/passwd` or `../../.bashrc` resolves and is read/written. With `bypass` hardcoded, there is no boundary at all.
- **bash classification trivially bypassed (HIGH).** `src/tools/bash.ts:18,22` use `input.command.trimStart().startsWith(cmd)`; `cd d && rm -rf x` is mislabeled (starts with `cd`). No chain-splitting, no sandbox.
- **bash output has no truncate-with-spill (HIGH).** `bash.ts:31` sets `maxBuffer: 10MB`; overflow is a hard `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, and anything under 10MB is dumped verbatim into history.
- **No multi-edit / atomic patch (HIGH); `fileRead` returns line-numbered content (MEDIUM)**; `webFetch` regex-strips tags with no Markdown/extraction and **no HTTPS upgrade / redirect hand-back / cache / domain gating** (MEDIUM); `webSearch` is a literal placeholder string (verified), `grep` lacks files-only/count modes and bundled `rg`, `glob` ignores `.gitignore` (MEDIUM).

**Top recommendations.**
- **R3.1 (P0):** Port the Codex `seek_sequence` ladder into a `locate()` helper (new `src/tools/lib/seekSequence.ts`) used by `src/tools/fileEdit.ts`.
- **R3.2 (P0):** Change `readFileState`'s value type to `{content, mtimeMs}` (`tools/types.ts`); have `fileRead.ts` store `statSync().mtimeMs` and `fileEdit.ts`/`fileWrite.ts` gate **first** on a matching mtime, else return a clean retryable error.
- **R3.3 (P0):** Add `resolveInside(root, p)` (new `src/tools/lib/paths.ts`) and use it in all file tools + bash cwd.
- **R3.4 (P1):** Cap bash output (`BASH_MAX_OUTPUT_LENGTH`, default 30k) and spill the remainder to a session file in `src/tools/bash.ts`; make classification chain-aware (split on `&& || ; |`, strip env-prefix/`/bin/`).
- **R3.5 (P2):** Give `grep` output modes + `glob` mtime-sort/gitignore (`src/tools/grep.ts`, `src/tools/glob.ts`); upgrade `webFetch` (HTTPS upgrade, `redirect:'manual'` cross-host hand-back, HTML→Markdown extract, cache) and either wire a real `webSearch` provider or mark F10 honestly (`src/tools/webFetch.ts`, `src/tools/webSearch.ts`).

---

### Dimension 4 — Permissions, approvals & sandboxing

**Best practice.** **Two orthogonal controls.** (1) An **OS-enforced sandbox** the whole process tree inherits — Codex ships an embedded `(deny default)` Seatbelt SBPL on macOS and bubblewrap+seccomp on Linux, with `read-only`/`workspace-write`/`danger-full-access` modes [[16]](#s16)[[17]](#s17); Claude Code's `/sandbox` (Seatbelt / bwrap), `~84% fewer prompts`, open-sourced as `@anthropic-ai/sandbox-runtime` [[19]](#s19). String-matching a command is **not** a sandbox. (2) A **tiered approval policy** with fixed precedence `hooks → DENY → mode → ALLOW → ask`, where **DENY overrides even full-bypass**, and a deliberately scary `--dangerously-*` flag that is **blocked as root** [[18]](#s18)[[20]](#s20). Network egress is off by default behind a hostname allow-list proxy. Self-protections: write-protect the agent's own config and `.git/hooks`; `failIfUnavailable` hard-fails rather than silently running unsandboxed [[19]](#s19).

**Alfred's gap.** A mode skeleton and nothing else:
- **Running agent hardcodes `bypass` (CRITICAL).** `src/repl.ts:69` sets `mode:"bypass"` unconditionally; `evaluatePermission` (`permissions/types.ts:38`) returns allow, so the only guard is an empty `deniedTools`. `configSchema.permissionMode` is never read; no `--dangerously-*` flag, no getuid check (verified).
- **No OS sandbox of any kind (CRITICAL).** `src/tools/bash.ts:29` runs `child_process.exec` with full user privileges; zero sandbox matches in `src`.
- **Approval is type-only (CRITICAL).** Every tool inherits `TOOL_DEFAULTS.checkPermissions → allow` (`tools/types.ts:93–97`); no tool overrides it (verified `checkPermissions` only in `types.ts`). So `default == auto == allow-all`, `plan == deny-all`, and the useful middle is missing; the sole `ask` consumer is the dead branch at `engine.ts:138–140`.
- **No path jail (HIGH); no egress policy (HIGH).** Covered in §3; `webFetch.ts:19` calls `fetch(input.url)` with no allow-list.
- **`permissionMode` config and `PermissionConfig.rules` are dead (HIGH).** Verified zero `.rules` consumers; `evaluatePermission` has no pattern matching, only whole-tool Sets — and **`bypass` short-circuits before `allowedTools`**, so a future deny rule would be skipped unless DENY is reordered first.
- **Misleading test masks the gap (LOW).** `tests/permissions.test.ts` defines a `defaultToolCheck` returning `"ask"` that no real tool returns; the suite is green while the integrated system does the opposite.

**Top recommendations.**
- **R4.1 (P0):** Stop hardcoding `bypass` in `src/repl.ts:68–73`: read `permissionMode` from config, default to `"default"` (ask on non-readonly), enter `bypass` only via `--dangerously-bypass-approvals` (add to `src/index.ts`) **refused when `getuid()===0`**.
- **R4.2 (P0):** Give `bash` (and `fileWrite`/`fileEdit`) a real `checkPermissions`: a hardcoded kill-list (`rm -rf /`, `mkfs`, `dd of=/dev/…`, fork-bomb) that returns `deny` **even under bypass**, auto-allow `isReadOnly` commands, else `ask` (`src/tools/bash.ts`).
- **R4.3 (P0):** Wrap bash in an OS sandbox (new `src/sandbox/`: `seatbelt.ts` via `sandbox-exec -f`, `bwrap.ts` with `--unshare-net`), detect availability at startup and **hard-fail** if requested but missing; or adopt `@anthropic-ai/sandbox-runtime`.
- **R4.4 (P1):** Implement first-match rule evaluation with tool+glob patterns (`bash(rm *)`, `file_read(./.env)`) in `permissions/types.ts`, evaluated **before** the bypass short-circuit; load from `settings.json`.
- **R4.5 (P1):** Interactive approval — thread `onPermissionRequest` through `ToolUseContext`/`executeToolCall` and render an approve/deny prompt in `src/components/Repl.tsx`, replacing the dead `ask` branch.

---

### Dimension 5 — Context management: caching, compaction, token budgeting, memory, subagents

**Best practice.** Five complementary mechanisms. **Caching:** prompt-cache the stable prefix (tools → system → memory) with explicit `cache_control` breakpoints (0.1× reads on Anthropic; min cacheable 2048–4096 tokens [[21]](#s21)); the harness rule is **append-only** (never prepend a volatile timestamp), and you verify `cache_read_input_tokens > 0`. **Token budgeting** off a model-accurate count (`count_tokens`/`tiktoken` [[23]](#s23)), never char/4. **Compaction:** at ~60–70% of the window, LLM-summarize-and-drop, splitting **only on a user-role boundary** so `tool_use`/`tool_result` pairs are never severed (Gemini `findCompressSplitPoint` [[25]](#s25); Codex `/responses/compact` mid-turn then `continue` [[26]](#s26)); microcompaction offloads bulky tool output to disk [[22]](#s22). **Memory:** a layered, size-capped hierarchy plus a `MEMORY.md` auto-index (~200 lines / 25KB), re-injected after compaction. **Subagents:** isolate exploratory work in a child with its own fresh window, returning only the final result [[28]](#s28). Aider's repo-map (tree-sitter + PageRank into a fixed token budget [[29]](#s29)) gives repo-wide structural awareness without dumping files.

**Alfred's gap.** Skeleton present, almost nothing wired, placeholders non-functional:
- **Compaction doesn't summarize and is never invoked (CRITICAL).** `src/compact/engine.ts:31–48 compactMessages(messages, options)` *concatenates* older messages verbatim (`[role] content`) — it can only grow the window — slices by message **count** (line 39), takes **no provider** (no LLM call possible), and has **zero callers** (verified). `engine.ts` grows `state.messages` unbounded into a hard `context_window_exceeded`; `/compact` (`commands/compact.ts`) returns "not yet implemented."
- **System prompt / CLAUDE.md / memory never injected (CRITICAL).** Same root cause as §2: `config.systemPrompt` is `undefined`, so the whole `src/context/` module and memory injection are dead.
- **No caching (HIGH).** Zero `cache_control` matches; the full prefix is re-billed at 1× every turn. The cost plumbing *can observe* hits (`fromAnthropicUsage` reads `cache_read_input_tokens`, `anthropic.ts:87`) but nothing writes a cache.
- **Token counting is char/4 (HIGH).** `anthropic.ts:185–187`, `openai.ts`, and `compact/engine.ts:15–18` all return `Math.ceil(text.length/4)`; `countTokens` is never even called.
- **Count-based split would sever tool pairs (HIGH); flat memory with no index/cap/startup-load (MEDIUM); subagent stub not registered (MEDIUM).** Also, the volatile `currentDate` is placed **before** CLAUDE.md in `buildSystemPrompt` — a cache-poisoning order if caching were added.

**Top recommendations.**
- **R5.1 (P0/P1):** First make Alfred send a system prompt (R2.1), then cache it: in `src/providers/anthropic.ts` send `system` as a content-block array with `cache_control: {type:'ephemeral'}` on the last block; verify via `response.usage.cache_read_input_tokens`. **Move `currentDate` last** in `buildSystemPrompt`.
- **R5.2 (P1):** Implement `AnthropicProvider.countTokens` via `client.messages.countTokens` (the SDK is already a dep) with a char/4 fallback; add a real tokenizer for OpenAI; route `compact/engine.ts` off these counts.
- **R5.3 (P0):** Make compaction real and **invoke it**: rewrite `compactMessages` to call the provider to summarize the head slice; compute the split with a `findUserBoundary()` helper; in `src/query/engine.ts` before each `provider.chat`, if over `(window − headroom)`, replace `state.messages` with `[summaryAsUser, ...kept]`. Wire `/compact` to the same path.
- **R5.4 (P1):** Accumulate `cacheRead/cacheWrite` in `state.totalUsage` and feed every turn into `CostTracker` (`engine.ts:50–51`); fix `OpenAIProvider.stream` to populate usage instead of zeros.
- **R5.5 (P2):** Implement the subagent via `query()` with its own message list returning only final text, and register it (see §6/D7).

---

### Dimension 6 — Extensibility: MCP, skills, hooks, plugins, slash commands

**Best practice.** Three pillars plus packaging. **MCP** across all transports (stdio + SSE + streamable HTTP) preserving each tool's real JSON Schema, with `includeTools`/`excludeTools`, auth, timeouts, per-server trust, and FQN naming (`mcp__server__tool`) so rules can target them [[33]](#s33). **Skills** with 3-level progressive disclosure (Level-1 name+description preload ~100 tokens; Level-2 body on match; Level-3 bundled scripts run via bash, output-only) on the portable `SKILL.md` standard [[31]](#s31). **Hooks** as deterministic policy — `PreToolUse`/`PostToolUse`/`UserPromptSubmit`/`SessionStart`/`Stop`/`PreCompact`, JSON on stdin, able to DENY/ALLOW/ASK/REWRITE, with the load-bearing exit-code contract: **exit 2 BLOCKS (stderr=reason), exit 0 = parse stdout JSON, exit 1 does NOT block** [[32]](#s32)[[34]](#s34). Packaging bundles commands+skills+agents+hooks+MCP into a versioned plugin via a SHA-pinned marketplace [[30]](#s30); untrusted hooks gated behind hash-based trust review [[34]](#s34). Slash commands are file-path-as-name with subdir namespacing and per-command allowed-tools.

**Alfred's gap.** Four of five primitives implemented as isolated libraries; the integration and safety pieces are missing:
- **MCP/skills/plugins implemented but never loaded (CRITICAL).** Verified: `loadSkillsFromDir`/`loadPluginFromDir`/`connectMcpServer` have no callers outside their own modules; `src/repl.ts:31–38` registers only the 15 built-in tools. A user's `SKILL.md`/`manifest.json`/MCP config does nothing.
- **No hooks system at all (CRITICAL).** Verified zero `hook` matches in `src`. `executeToolCall` (`engine.ts:111–148`) goes validate → permission → call with no dispatch points; no `SessionStart`/`Stop`/`UserPromptSubmit`.
- **MCP bridge discards schemas and hardcodes read-only (HIGH).** `src/mcp/types.ts:41` uses `z.object({}).passthrough()`; lines 42–43 hardcode `isReadOnly: () => true` and `isConcurrencySafe: () => true` — so a destructive MCP tool is always fired in the parallel batch with no prompt. **stdio-only**, no SSE/HTTP, no auth/timeouts/trust/allow-lists.
- **Skills have no progressive disclosure (HIGH).** `src/skills/loader.ts` stores the whole body as the payload; no Level-1 preload (model can't autonomously match), no bundled scripts.
- **No named-subagent registry; agent tool is a stub (HIGH).** `src/tools/agent.ts:14–18` returns a literal string and is not registered.
- **Plugins aren't real bundles / no distribution (MEDIUM); slash commands lack namespacing + per-command tool scoping (MEDIUM); `updatedInput` is plumbed but ignored (MEDIUM)** — `evaluatePermission` returns `updatedInput` but `executeToolCall` passes `parsed.data` (`engine.ts:143`), so a rewrite is silently dropped (the exact seam a `PreToolUse` hook would use).

**Top recommendations.**
- **R6.1 (P1):** Add `bootstrapExtensions()` (new `src/extensions/bootstrap.ts`, awaited in `runRepl` before render) that calls `loadSkillsFromDir`, `loadPluginFromDir`, and `connectMcpServer` from config and registers their tools — turns three tested-but-dead modules into working features.
- **R6.2 (P1):** Add a hooks engine (new `src/hooks/runner.ts`) with the **exit-2-blocks** contract; dispatch `PreToolUse` in `executeToolCall` before `evaluatePermission`, `PostToolUse` after `tool.call`, and session events in `src/repl.ts`. (Get exit-1-does-not-block right — the classic footgun.)
- **R6.3 (P1):** Make the MCP bridge faithful: convert `inputSchema` JSON Schema → Zod, default `isReadOnly` to **false** unless `annotations.readOnlyHint`, add `includeTools`/`excludeTools` + timeouts + per-server trust (`src/mcp/types.ts`).
- **R6.4 (P1, quick):** Honor `permResult.updatedInput` in `executeToolCall` (`engine.ts:143`) and surface `ask` as an event — unblocks both `checkPermissions` and future hook rewrites.
- **R6.5 (P2):** 3-level skills (Level-1 catalog into the system prompt; `skills/<name>/SKILL.md` directories; Level-3 scripts via bash) and SSE/HTTP MCP transports.

---

### Dimension 7 — Autonomous long-running harness, eval, checkpointing, multi-agent

**Best practice.** Long-running autonomy is enforced runtime machinery: a **headless entrypoint** with a clean stream contract (progress→stderr, final message→stdout, `--output-format json|stream-json` NDJSON — Codex `codex exec` [[35]](#s35); Claude `-p --output-format stream-json`); **layered stop conditions** wired into the loop with a **turn-limit-specific exit code** so a wrapper can tell "resume" from "failed" (Gemini exit 53 [[36]](#s36)); **automatic per-prompt file checkpointing** with selective restore (Claude `/rewind` + SDK `rewindFiles(uuid)` [[38]](#s38); Gemini's shadow-git also catches bash mutations [[36]](#s36)); two distinct multi-agent modes — isolated subagents with a hard recursion cap (Codex `max_depth=1`; Claude no-nesting [[39]](#s39)) vs. true teams coordinating through a file-locked task list [[40]](#s40); and the single highest-leverage reliability primitive — an **objective verification gate inside the loop**: re-edit until lint/test exit code is 0 (Aider `--auto-test` [[41]](#s41); Devin against CI). State of the art layers inference-time scaling (OpenHands best-of-5 lifts SWE-bench Verified 60.6%→66.4% via a trained critic [[42]](#s42)); trust is proven on anti-gaming harnesses (SWE-bench Verified hides the test patch, requires both FAIL_TO_PASS and PASS_TO_PASS [[43]](#s43)).

**Alfred's gap.** The headline capability is entirely prose, fully decoupled from the runtime:
- **Entire harness is prose, not code (CRITICAL).** Verified `grep -rniE 'feature_list|autonomous|init.sh|evaluator-rubric' src` → zero. The WHILE/IF loop, `max_iterations_per_feature=5`, `max_consecutive_blocked=2`, `stop_on_budget_remaining_percent=20`, and `loop_detection_threshold=0.8` live only in `CLAUDE.md`/`autonomous-loop.md`/`feature_list.json` for an external operator. *The `.harness/config.json` already maps `verify → bun test`, and `init.sh verify` runs it — the exit code just needs to reach the loop.*
- **No checkpoint/rewind/rollback of any kind (CRITICAL).** Verified the only "snapshot" match is an unrelated git-status string. `autonomous-loop.md` promises rollback-on-regression; `engine.ts` edits files with no snapshot and no revert.
- **Headless `-p` violates the stdout contract (HIGH).** `src/repl.ts:171–193 runQueryText` joins **all** events including chalk-colored `[tool: …]` traces (lines 182–185) onto stdout; no `--output-format`, no stderr/stdout split, no `exec` subcommand in `src/index.ts`. `alfred -p … | tee out.md` captures ANSI noise, not a clean answer.
- **No turn-limit-specific exit code (HIGH); subagent stub (HIGH); task store in-memory only (HIGH).** `src/tasks/store.ts` is a module-level `Map` with zero disk I/O (verified) — task state is lost on exit, defeating the harness's cross-session premise.
- **Verification gate never executed (HIGH).** `evaluator-rubric.md` is a human-filled table; verified zero `critic|verifier|evaluat` matches beyond permission code. `feature_list.json` marks F10 "passing" on evidence `"webSearch placeholder, agentTool placeholder"` — the exact gaming SWE-bench Verified is designed to prevent.
- **No session persistence/resume (MEDIUM); cost tracker not a stop condition (MEDIUM); hardcoded bypass (MEDIUM, see §4); loop-detection/regression-rollback specified but inert (MEDIUM).**

**Top recommendations.**
- **R7.1 (P2 — the flagship):** Wire `init.sh`'s `VERIFY_CMD` (`bun test`) exit code into a verify-fix loop (new `src/harness/verifyLoop.ts` calling `src/query/engine.ts` + `src/tools/bash.ts`): on non-zero, feed captured stdout/stderr as the next user turn, repeat up to `feature.iteration_budget`. Smallest change, biggest reliability payoff.
- **R7.2 (P1):** Add `alfred exec` with progress→stderr, final-text→stdout, and `--output-format text|json|stream-json` NDJSON (`src/index.ts` + new `src/headless.ts`).
- **R7.3 (P2):** Shadow-git per-turn checkpoint + `rewind` (new `src/harness/checkpoint.ts`; snapshot the whole tree via `git stash create` so it also catches bash `rm`/`mv`), called around the tool block in `engine.ts`.
- **R7.4 (P0/P1):** Typed terminal status + distinct exit codes (turn-limit → 53) and budget/turn caps enforced in `engine.ts` (overlaps R1.3).
- **R7.5 (P2):** Persist `src/tasks/store.ts` to `.alfred/tasks.json` and the transcript to `.alfred/sessions/<id>.json`; add `--resume`.

---

## 3. Scorecard

Maturity is 1 (absent/dead) → 5 (production-grade). Alfred scores reflect *what runs*, not what is written.

| Dimension | **Alfred (1–5)** | Codex CLI | Gemini CLI | Claude Code |
|---|---|---|---|---|
| 1. Agent loop & orchestration | **2** — correct stop condition, but no retry/stream/cancel; one error type | 5 — `needs_follow_up` loop, retry+`Retry-After`, mid-turn compaction, cancel token [[2]](#s2)[[3]](#s3) | 4 — typed `Turn` events, scheduler state machine, `checkNextSpeaker` [[4]](#s4)[[5]](#s5) | 5 — turn-as-tool-roundtrip, typed `ResultMessage`, partial-message streaming [[1]](#s1) |
| 2. System prompt & memory files | **1** — builder is dead code; runs with no prompt | 5 — per-model `prompt.md`, AGENTS.md walk, `experimental_instructions_file` [[8]](#s8)[[9]](#s9) | 5 — programmatic `snippets.ts`, quantified tone rule, `GEMINI_SYSTEM_MD` [[10]](#s10) | 5 — 100+ fragment mosaic, 5-layer CLAUDE.md, auto-memory [[7]](#s7) |
| 3. Tool design | **2** — clean contract, exact-match edit, no jail, no spill | 5 — freeform `apply_patch` + fuzzy ladder, sandbox modes [[11]](#s11)[[13]](#s13) | 4 — multi-stage edit correction, chain-split bash, diff-confirm [[27]](#s27) | 5 — mtime-first Edit, output spill, extract-by-prompt WebFetch [[14]](#s14) |
| 4. Permissions & sandboxing | **1** — hardcoded `bypass`, no sandbox, `ask` unimplemented | 5 — Seatbelt/bwrap + orthogonal approval axes [[16]](#s16)[[17]](#s17) | 5 — 6 Seatbelt profiles, Docker/gVisor, enterprise lockdown [[37]](#s37) | 5 — rule engine, `/sandbox`, self-config protection [[18]](#s18)[[19]](#s19) |
| 5. Context mgmt (cache/compact/budget) | **1** — no cache, char/4 tokens, compaction concatenates & never runs | 4 — `/responses/compact` mid-turn, prefix caching [[26]](#s26) | 5 — user-boundary split, 1M window, 75% cache discount [[25]](#s25) | 5 — micro+auto compaction, `cache_control`, real `count_tokens` [[21]](#s21)[[22]](#s22) |
| 6. Extensibility (MCP/skills/hooks/plugins) | **2** — 4 primitives built but unloaded; no hooks; MCP drops schema | 5 — TOML MCP/hooks/agents, SKILL.md, hash-trusted hooks [[34]](#s34) | 5 — all MCP transports+OAuth, extensions bundle [[33]](#s33) | 5 — plugins+marketplace, 8 hook events, 3-level skills [[30]](#s30)[[32]](#s32) |
| 7. Autonomy / eval / checkpoint / multi-agent | **1** — harness 100% prose; in-mem tasks; subagent stub; rubric never run | 4 — `codex exec` NDJSON, `max_depth`, git rollback [[35]](#s35) | 4 — exit 53, shadow-git checkpoints, `--resume` [[36]](#s36) | 5 — `/rewind`+SDK checkpoints, agent teams, `--max-budget-usd` [[38]](#s38)[[40]](#s40) |

**Alfred's distinctive asset** — a more opinionated *autonomy spec* than any reference CLI — is real but currently unscored because nothing enforces it. Executing it (D7) is how Alfred earns a column of its own.

---

## 4. Prioritized roadmap

Ordered by severity. Effort: **S** ≈ hours, **M** ≈ 1–2 days, **L** ≈ multi-day.

### P0 — correctness / cost / safety must-fixes

| # | What | Where (Alfred file) | Effort |
|---|---|---|---|
| 1 | **Wire the system prompt into the loop** (call `buildSystemContext`+`buildSystemPrompt`, set `config.systemPrompt`) — resurrects all of `src/context/` | `src/repl.ts` | S |
| 2 | **Retry-with-backoff** around `provider.chat()`, prefer `Retry-After`, bypass context/usage errors | `src/query/engine.ts` + new `src/query/retry.ts` | M |
| 3 | **Stop hardcoding `bypass`**; default to "ask"; gate full-auto behind `--dangerously-bypass-approvals` refused as root | `src/repl.ts:68–73`, `src/index.ts` | S |
| 4 | **Real `checkPermissions` on bash + a kill-list that beats bypass**; auto-allow read-only, else ask | `src/tools/bash.ts`, `src/tools/fileWrite.ts`, `src/tools/fileEdit.ts` | M |
| 5 | **Fuzzy matcher for `fileEdit`** (Codex seek_sequence ladder) | `src/tools/fileEdit.ts` + new `src/tools/lib/seekSequence.ts` | M |
| 6 | **Read-before-write + mtime freshness gate**; change `readFileState` to `{content,mtimeMs}` | `src/tools/fileRead.ts`, `fileEdit.ts`, `fileWrite.ts`, `tools/types.ts` | M |
| 7 | **Path containment jail** for all file tools + bash cwd | new `src/tools/lib/paths.ts` + 4 tool files | S |
| 8 | **Real, invoked compaction** (LLM summary, user-boundary split, called each turn) | `src/compact/engine.ts`, `src/query/engine.ts` | L |
| 9 | **Thread `maxTokens` end-to-end** (kill the silent 4096 truncation) | `src/query/types.ts`, `src/query/engine.ts`, `src/repl.ts` | S |
| 10 | **Typed terminal status + distinct exit codes** (turn-limit ≠ provider error; budget cap via `CostTracker`) | `src/query/engine.ts`, `src/query/types.ts`, `src/index.ts` | S→M |

### P1 — parity

| # | What | Where | Effort |
|---|---|---|---|
| 11 | **OS sandbox for bash** (Seatbelt via `sandbox-exec`, bwrap on Linux), `failIfUnavailable` | new `src/sandbox/` + `src/tools/bash.ts` | L |
| 12 | **Switch the loop to `provider.stream()`** (activate dead streaming code) | `src/query/engine.ts`, `src/repl.ts` | M |
| 13 | **Prompt caching** on the stable prefix (move `currentDate` last) | `src/providers/anthropic.ts`, `src/context/index.ts` | M |
| 14 | **Real tokenizer** (`messages.countTokens`; tiktoken for OpenAI) | `src/providers/anthropic.ts`, `openai.ts`, `compact/engine.ts` | M |
| 15 | **Flesh out the system prompt** (tone/anti-over-engineering/tool-policy/git-NEVER/citations) | `src/context/index.ts` | M |
| 16 | **Discover AGENTS.md** alongside CLAUDE.md | `src/context/claudemd.ts` | S |
| 17 | **Bootstrap MCP/skills/plugins at startup** (run the dead loaders) | new `src/extensions/bootstrap.ts`, `src/repl.ts` | M |
| 18 | **Hooks engine** with the exit-2-blocks contract + dispatch points | new `src/hooks/`, `src/query/engine.ts`, `src/repl.ts` | L |
| 19 | **Faithful MCP bridge** (real schema, derived read-only, allow/deny, timeouts) | `src/mcp/types.ts` | M |
| 20 | **Honor `updatedInput` + interactive `ask` UI** | `src/query/engine.ts:143`, `src/components/Repl.tsx` | S→M |
| 21 | **Rule engine** (tool+glob patterns; DENY before bypass) | `src/permissions/types.ts`, `src/config/manager.ts`, `src/repl.ts` | M |
| 22 | **bash truncate-with-spill**; chain-aware classification | `src/tools/bash.ts` | M |
| 23 | **Headless `alfred exec`** (stderr/stdout split + NDJSON) | `src/index.ts`, new `src/headless.ts` | M |
| 24 | **Accrue cache/full usage into `CostTracker`**; fix `openai.stream` zero-usage | `src/query/engine.ts`, `src/providers/openai.ts` | S |

### P2 — polish & differentiation

| # | What | Where | Effort |
|---|---|---|---|
| 25 | **Executable verify-fix loop** against `bun test` exit code (the flagship) | new `src/harness/verifyLoop.ts` | M |
| 26 | **Executable rubric gate** — a feature cannot flip to `passing` unless Verification axis is backed by a real captured exit 0 | new `src/harness/selfEval.ts`, `feature_list.json` writer | M |
| 27 | **Shadow-git checkpoint + regression rollback** | new `src/harness/checkpoint.ts`, `src/query/engine.ts` | M |
| 28 | **Structural stuck-detector + diff-similarity (>0.8) guard** → `stuck` status | new `src/query/stuck.ts`, `src/harness/loopDetect.ts` | S |
| 29 | **Persist task store + session; `--resume`** | `src/tasks/store.ts`, new `src/session/store.ts`, `src/repl.ts` | M |
| 30 | **Real subagent via `query()` + depth cap; register it** | `src/tools/agent.ts`, `src/repl.ts:31–38`, `src/tools/types.ts` | M |
| 31 | **3-level skills; grep modes; glob gitignore; webFetch extract+SSRF; real/honest webSearch** | `src/skills/loader.ts`, `src/context/index.ts`, `src/tools/grep.ts`, `glob.ts`, `webFetch.ts`, `webSearch.ts` | M→L |
| 32 | **`MEMORY.md` startup index (size-capped) injected as context** | `src/memory/store.ts`, `src/context/index.ts` | M |
| 33 | **Fix the misleading permissions test** to assert end-to-end (kill-list beats bypass; repl doesn't hardcode bypass) | `tests/permissions.test.ts`, new `tests/repl-mode.test.ts` | S |

---

## 5. Brainstorm: don't just clone

Alfred's biggest finding is also its biggest opportunity. The repo already *designed* a more opinionated autonomous harness than Codex, Gemini, or Claude Code — it just never shipped it as runtime. Don't spend the budget reaching streaming/sandbox parity and stopping there; **invert the weakness**: make the spec the executable, auditable contract.

### Differentiators (ship these to stand out)

1. **Make the autonomous harness EXECUTABLE — `alfred run` as a state machine over `feature_list.json` (effort L).** Read the highest-priority `not_started` feature → run the verify-fix inner loop → mark `passing`/`blocked` → commit → next, enforcing the *exact* configured thresholds (`max_iterations_per_feature=5`, `max_consecutive_blocked=2`, `stop_on_budget_remaining_percent=20`, `loop_detection_threshold=0.8`). New `src/harness/`. This converts the headline claim from undemonstrable to runnable in one binary. Inspiration: Codex `tasks/regular.rs` outer loop; Gemini `MAX_TURNS`+exit-53; Alfred's own `autonomous-loop.md`.

2. **Promote `evaluator-rubric.md` into a code-driven self-eval GATE (effort M).** A feature **cannot** transition to `passing` unless the Verification axis = 2 *backed by a captured exit-code+stdout artifact* (the feature's own `auto_check` must actually have run with exit 0). This is strictly ahead of the field — OpenHands uses a trained critic, Claude teams a `TaskCompleted` hook, Aider an exit-0 loop, but **none ship a structured multi-axis acceptance rubric as a state gate** — and it directly kills the pathology already visible in `feature_list.json` (F10 "passing" on `"agentTool placeholder"`). `self-eval-trigger.md` even warns the agent "容易给自己打高分"; enforce it.

3. **Wire `init.sh`'s `VERIFY_CMD` into the loop as the verify-fix inner loop (effort M).** Alfred is unusually close: `.harness/config.json` already maps `verify → bun test`, `CLAUDE.md`'s 内层 build-test loop describes the behavior in prose, and the bash tool exists. Closing "model edits → tests fail → error fed back → model fixes → exit 0" is the difference between "an agent that writes code" and "an agent that writes code that passes."

4. **Typed terminal-status contract + distinct exit codes (effort S).** `success | max_turns | max_budget | blocked | stuck | regressed | provider_error` on `QueryState`, mapped to process exit codes. This is the connective tissue that makes every other autonomy feature (resume, CI gating, best-of-N) composable, and lets `alfred run` emit a real 自治工作总结 instead of dumping text.

5. **Deterministic, HMAC-signed run receipts (effort M).** Every autonomous run emits an append-only JSONL ledger (per turn: feature id, tool-call input hashes, `VERIFY_CMD` exit code, rubric scores, token/cost delta, git SHA before/after) plus a signed summary — making each run replayable and **tamper-evident**, and giving `feature_list.json`'s `evidence` cryptographic backing instead of a hand-typed string. This leans directly into the owner's proven house style (`trace-vault` record/replay, `provenant` HMAC Proof Receipts) and fixes a real integrity hole: today `claude-progress.md`/`evidence` are free-text the agent writes *about itself*.

6. **Shadow-git per-turn checkpoint + regression rollback (effort M).** Because Alfred mutates via **both** `fileEdit` and `bash`, a whole-tree shadow-git snapshot (Gemini's design) is the correct choice — it catches the bash `rm`/`mv` that Claude Code's edit-tool-only checkpointing misses. This makes `autonomous-loop.md`'s promised rollback-on-regression executable and lets the agent self-revert a turn the rubric *Blocks*.

7. **Deterministic stuck-detection (effort S).** A structural detector (ring buffer of `toolName+hash(input)+isError`; halt on 4 identical / 6 alternating) plus the spec'd commit-diff-similarity>0.8 check — pure functions, both emitting `stuck`. This dogfoods Alfred's own `CLAUDE.md` Rule 5 ("代码能回答的，让代码回答" — don't pay an LLM to notice it's stuck).

### Moonshots

- **Alfred-Bench: a self-hosting, anti-gaming autonomy benchmark.** Alfred drives *its own* `feature_list.json` from an empty `src/` to all-green under the executable harness, with **held-out verification** (the real `bun test` is withheld from the model and run only by the harness, requiring both the new behavior *and* that prior passing features still pass — a SWE-bench-Verified-style dual pass-condition [[43]](#s43)). The deliverable is a signed, replayable trajectory ledger of that bootstrap run. "Watch it rebuild itself under a gate it can't cheat" is a headline no job-search CLI clone has.
- **Best-of-N with an objective reward.** For a hard feature, fan out N trajectories across Alfred's **two existing providers**, select the candidate whose `VERIFY_CMD` exits 0 (tie-break on fewest failing assertions + lowest cost from the existing `CostTracker`), and record why the winner won in the ledger — OpenHands-style inference-time scaling [[42]](#s42) **without** needing a trained critic, because an executable verifier is a cheaper, more honest reward than an LLM judge.
- **A faithfulness/determinism harness for Alfred itself** (the `trace-vault` pattern applied inward): record every model+tool interaction, replay to assert the orchestrator is deterministic given fixed model outputs, and check that the rubric's claimed evidence corresponds to a real captured exit code — explicitly separating "the run is reproducible" from "the agent's self-report is faithful."

### Positioning

> **Alfred should be the *verifiable autonomous coding agent*** — not another Claude Code clone, but the one CLI where the long-running harness is executable, the "done" bar is a machine-enforced gate, and every hands-off run leaves a signed, replayable receipt. Its competitors stream tokens and parallelize tools; Alfred's distinctive claim is **reliability you can audit**: it reads `feature_list.json` as a live state machine, runs an Aider/Devin-style verify-fix loop against a real `bun test` exit code, refuses to mark a feature `passing` until an executable rubric (Verification = 2, backed by captured output) approves the transition, snapshots and auto-rolls-back regressions, halts deterministically on budget/stuck/loop conditions with typed exit codes, and emits an HMAC-signed, git-SHA-pinned trajectory ledger a third party can replay to confirm the work. Built in TS/Bun (the Gemini-CLI peer stack) and grounded in the anti-gaming bar (SWE-bench-Verified hidden-test dual pass-condition, OpenHands objective-reward selection), it turns the repo's current weakness — a rich spec nothing enforces — into its flagship, and slots beside `trace-vault` and `provenant` as the coding-agent pillar of a coherent "provable agent reliability" portfolio that directly demonstrates senior Agent-Engineer judgement.

**The honest sequencing:** ship P0 (the binary must run with a prompt, retry, not auto-`rm -rf`, and not silently overflow) → P1 (reach parity so reviewers take it seriously) → P2/differentiators (make autonomy executable and auditable — the only part that makes Alfred *memorable*).

---

## 6. Sources

<a id="s1"></a>[1] Claude Code — Agent SDK agent loop: https://code.claude.com/docs/en/agent-sdk/agent-loop
<a id="s2"></a>[2] Codex — turn loop (`session/turn.rs`): https://github.com/openai/codex/blob/main/codex-rs/core/src/session/turn.rs
<a id="s3"></a>[3] Codex — responses retry/backoff: https://github.com/openai/codex/blob/main/codex-rs/core/src/responses_retry.rs
<a id="s4"></a>[4] Gemini CLI — tool scheduler state machine: https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/scheduler/scheduler.ts
<a id="s5"></a>[5] Gemini CLI — next-speaker checker: https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/nextSpeakerChecker.ts
<a id="s6"></a>[6] OpenHands — stuck detection (`stuck.py`): https://github.com/OpenHands/OpenHands/blob/main/openhands/controller/stuck.py
<a id="s7"></a>[7] Claude Code — memory & CLAUDE.md: https://code.claude.com/docs/en/memory
<a id="s8"></a>[8] Codex — AGENTS.md discovery (`agents_md.rs`): https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs · AGENTS.md standard: https://agents.md/
<a id="s9"></a>[9] Codex — per-model system prompt: https://github.com/openai/codex/blob/main/codex-rs/core/gpt_5_codex_prompt.md
<a id="s10"></a>[10] Gemini CLI — prompt snippets: https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/prompts/snippets.ts
<a id="s11"></a>[11] Codex — `apply_patch` fuzzy matcher (`seek_sequence.rs`): https://github.com/openai/codex/blob/main/codex-rs/apply-patch/src/seek_sequence.rs
<a id="s12"></a>[12] Aider — unified diffs / edit-format error analysis: https://aider.chat/docs/unified-diffs.html · https://aider.chat/docs/more/edit-formats.html
<a id="s13"></a>[13] Codex — freeform `apply_patch` (PR #21687): https://github.com/openai/codex/pull/21687 · instructions: https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/apply_patch_tool_instructions.md
<a id="s14"></a>[14] Claude Code — tools reference: https://code.claude.com/docs/en/tools-reference
<a id="s15"></a>[15] Codex — sandboxing concepts: https://developers.openai.com/codex/concepts/sandboxing
<a id="s16"></a>[16] Codex — Seatbelt base policy (SBPL): https://github.com/openai/codex/blob/main/codex-rs/sandboxing/src/seatbelt_base_policy.sbpl
<a id="s17"></a>[17] Codex — Seatbelt implementation: https://github.com/openai/codex/blob/main/codex-rs/sandboxing/src/seatbelt.rs · approvals/security: https://developers.openai.com/codex/agent-approvals-security
<a id="s18"></a>[18] Claude Code — sandboxing: https://code.claude.com/docs/en/sandboxing
<a id="s19"></a>[19] Anthropic — Claude Code sandboxing (engineering): https://www.anthropic.com/engineering/claude-code-sandboxing
<a id="s20"></a>[20] Claude Code — Agent SDK permissions: https://code.claude.com/docs/en/agent-sdk/permissions · settings: https://code.claude.com/docs/en/settings
<a id="s21"></a>[21] Anthropic — prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
<a id="s22"></a>[22] Anthropic — compaction: https://platform.claude.com/docs/en/build-with-claude/compaction
<a id="s23"></a>[23] Anthropic — token counting: https://platform.claude.com/docs/en/build-with-claude/token-counting
<a id="s24"></a>[24] Claude Code compaction deep-dive: https://decodeclaude.com/compaction-deep-dive/
<a id="s25"></a>[25] Gemini CLI — chat compression / context management: https://deepwiki.com/google-gemini/gemini-cli/4.12-chat-compression-and-context-management
<a id="s26"></a>[26] Codex CLI — context compaction architecture: https://codex.danielvaughan.com/2026/03/31/codex-cli-context-compaction-architecture/
<a id="s27"></a>[27] Gemini CLI — tools index (edit/search/shell): https://github.com/google-gemini/gemini-cli/blob/HEAD/docs/tools/index.md
<a id="s28"></a>[28] Claude Code — subagents (SDK): https://code.claude.com/docs/en/agent-sdk/subagents
<a id="s29"></a>[29] Aider — repository map: https://aider.chat/docs/repomap.html
<a id="s30"></a>[30] Claude Code — plugins: https://code.claude.com/docs/en/plugins
<a id="s31"></a>[31] Claude Code — Agent Skills overview: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
<a id="s32"></a>[32] Claude Code — hooks: https://code.claude.com/docs/en/hooks
<a id="s33"></a>[33] Gemini CLI — MCP server config: https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.md · extensions: https://google-gemini.github.io/gemini-cli/docs/extensions/
<a id="s34"></a>[34] Codex — hooks: https://developers.openai.com/codex/hooks · skills: https://developers.openai.com/codex/skills · config reference: https://developers.openai.com/codex/config-reference
<a id="s35"></a>[35] Codex — non-interactive `exec`: https://developers.openai.com/codex/noninteractive · CLI reference: https://developers.openai.com/codex/cli/reference
<a id="s36"></a>[36] Gemini CLI — headless mode (exit codes, output formats): https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md
<a id="s37"></a>[37] Gemini CLI — sandbox: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/sandbox.md · enterprise: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/enterprise.md
<a id="s38"></a>[38] Claude Code — checkpointing: https://code.claude.com/docs/en/checkpointing · SDK file checkpointing: https://code.claude.com/docs/en/agent-sdk/file-checkpointing
<a id="s39"></a>[39] Claude Code — sub-agents: https://code.claude.com/docs/en/sub-agents · Codex subagents: https://developers.openai.com/codex/subagents
<a id="s40"></a>[40] Claude Code — agent teams: https://code.claude.com/docs/en/agent-teams
<a id="s41"></a>[41] Aider — lint/test self-healing loop: https://aider.chat/docs/usage/lint-test.html
<a id="s42"></a>[42] OpenHands — SOTA via inference-time scaling + critic: https://www.openhands.dev/blog/sota-on-swe-bench-verified-with-inference-time-scaling-and-critic-model
<a id="s43"></a>[43] SWE-bench (Verified, anti-gaming dual pass-condition): https://github.com/SWE-bench/SWE-bench
<a id="s44"></a>[44] Claude Code — streaming output: https://code.claude.com/docs/en/agent-sdk/streaming-output
<a id="s45"></a>[45] Codex CLI architecture / agent-loop design (ZenML LLMOps): https://www.zenml.io/llmops-database/building-production-ready-ai-agents-openai-codex-cli-architecture-and-agent-loop-design
<a id="s46"></a>[46] Amp — permissions model: https://ampcode.com/permissions · manual: https://ampcode.com/manual
<a id="s47"></a>[47] opencode — plugins: https://opencode.ai/docs/plugins/
<a id="s48"></a>[48] Cline — strict-match edit anti-pattern (issue #2909): https://github.com/cline/cline/issues/2909 · auto-approve: https://docs.cline.bot/features/auto-approve
<a id="s49"></a>[49] Leaked Claude Code system prompts (fragment reference): https://github.com/Piebald-AI/claude-code-system-prompts
<a id="s50"></a>[50] Gemini — implicit caching (75% discount): https://developers.googleblog.com/en/gemini-2-5-models-now-support-implicit-caching/
