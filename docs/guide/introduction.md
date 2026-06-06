# Introduction

Alfred is a verifiable autonomous coding agent CLI. Where most coding agents stop at "the model did something," Alfred makes that something provable: every hands-off run leaves a signed, replayable receipt; "done" is a machine-enforced exit-code gate, not a self-report; and the agent's memory is curated by the model but auditable by anyone with a text editor.

---

## The thesis in one paragraph

Alfred's design rests on four claims, each enforceable in code:

1. **The harness is executable.** `alfred run` is not a script that prompts the model and hopes — it is a deterministic state machine (`src/orchestrator/workflows/autonomousRun.ts`) that drives a `feature_list.json` through an implement → verify → rubric loop. Control flow is hand-wired; the model fills the boxes.
2. **"Done" is a machine-enforced gate.** A feature cannot be marked `passing` unless an objective verify command (e.g. `bun test`) exits with code 0 *and* a structured rubric agent scores it 2/2. No LLM self-report can override that dual gate (`src/harness/verify.ts`).
3. **Memory is agent-curated but inspectable.** The model reads and writes plain Markdown files and a SQLite FTS5 index under `.alfred/memory/` — you can `cat`, `git diff`, or hand-edit any of them (`src/memory/localFile.ts`).
4. **Every run leaves a signed, replayable receipt.** The orchestrator appends an HMAC hash-chained ledger (`src/orchestrator/ledger.ts`) to `.alfred/workflows/<runId>/ledger.jsonl`; `Ledger.verify()` detects any post-hoc edit or reorder.

---

## How Alfred is different from Claude Code and Codex CLI

Alfred is not a clone. The improvement proposal (`docs/improvement-proposal.md`) frames the design explicitly as *best-of-breed synthesis, not parity*. Here is the honest breakdown:

| Dimension | Claude Code / Codex | Alfred |
|---|---|---|
| **Autonomy harness** | Convention-based; `done` is a model self-report | Machine-enforced dual gate (verify exit 0 + rubric 2); deterministic state machine |
| **Run receipt** | No cryptographic audit trail | HMAC hash-chained ledger; tamper-detectable via `Ledger.verify()` |
| **Agent-layer security** | No taint fence, no egress allow-list shipped by default | Taint fence on all untrusted content (`src/security/taint.ts`), egress allow-list (`src/security/egress.ts`), secret redaction (`src/security/redact.ts`) |
| **Memory** | External or session-scoped | File-first tiered store: `USER.md` + `MEMORY.md` index + `facts/*.md` + `episodes/` + SQLite FTS5; GC on session end |
| **Orchestration** | Cloud-based sub-agents | Local `agent()/parallel()/pipeline()` runtime with a journal that doubles as a resume tape |
| **Model routing** | Single model | Architect / editor / subagent role-to-model map; retry escalates through the fallback chain |

Where the field is ahead — streaming polish, sandbox depth, caching parity — Alfred adopts the best ideas (see `docs/adr/0001-target-architecture.md` §7) rather than competing on those dimensions as the primary value proposition.

---

## The one design tension Alfred holds throughout

*Agent-curated* vs. *verifiable*. The LLM decides what to remember, what to implement, and when to call something done — but a deterministic check disposes of every consequential claim. This is Design Principle P4 in the architecture decision record:

> **Agent-proposes, machine-verifies.** The LLM proposes (what to remember, that a feature is done); a deterministic check disposes (exit codes, schema validation, contradiction scan, HMAC).

That tension is why Alfred exists as a separate project.

---

## The headline differentiators at a glance

**Signed run ledger.** Every `alfred run` appends to a JSONL file where each entry's HMAC signature covers its own payload plus the previous entry's signature, forming a hash chain. Tampering with any entry — editing it, reordering it, truncating the file — is detectable. This is Alfred's `provenant`-style Proof Receipt.

**Machine-enforced verify gate.** The harness calls `runVerify()` and inspects `exitCode === 0`. It does not ask the model whether the tests passed. A feature is only marked `passing` when that binary condition holds *and* the rubric self-eval independently agrees.

**Agent-layer security that no mainstream harness ships.** The lethal trifecta (Simon Willison's framing) is: private data + untrusted content + an exfiltration channel in one context. Alfred defends against it architecturally — untrusted content from `web_fetch`, MCP, and `bash` is fenced as data-not-instructions (`src/security/taint.ts`); outbound HTTP is allow-listed by default; secrets are redacted before they reach context or the ledger. No competitor ships all three.

**Memory that GCs itself.** On session end, `LocalFileProvider.extract()` scans every stored fact for expired TTL or a `scope` path that no longer exists on disk, and moves stale facts to `archive/`. "Stale memory is the #1 cause of weird behavior" (Hermes Agent docs) is treated as a first-class GC concern, not advice.

---

## Where to go next

- [Quickstart](/guide/quickstart) — three first runs end-to-end, with expected output shapes.
- [Installation](/guide/installation) — prerequisites, `bun install`, and the `alfred` binary.
- [Core concepts](/guide/concepts) — the agent loop, tools, permissions, memory, and the autonomy harness.
- [Architecture ADRs](/adr/0001-target-architecture) — the decision records behind every design choice.
