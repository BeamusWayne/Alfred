# ADR 0003 — Agent-layer security: prompt-injection & exfiltration defense

**English** | [中文](./0003-agent-layer-security.zh-CN.md)

- **Status:** Proposed
- **Date:** 2026-06-05
- **Relates to:** [ADR 0001](./0001-target-architecture.md) · [`improvement-proposal.md` §6.2](../improvement-proposal.md#62-agent-layer-security-prompt-injection--exfiltration-defense)

## Context

This is distinct from OS sandboxing ([ADR 0001](./0001-target-architecture.md)/§7.3 bounds *what the process can do*); this bounds *what untrusted content can make the agent do*. The threat is Simon Willison's **lethal trifecta** — private data + untrusted content + an exfiltration channel in one context; any two are safe, all three is exploitable.

Alfred today has the **full trifecta wide open**: it reads private repo data, ingests untrusted content (`src/tools/webFetch.ts` fetches arbitrary URLs; the MCP bridge pipes arbitrary server output straight into context), and has exfiltration channels (no-egress `bash`/`webFetch`). With `mode:"bypass"` hardcoded (review), a single poisoned web page or MCP response can instruct Alfred to read `.env` and `curl` it out. Tool outputs are concatenated verbatim with no provenance. Notably, **no mainstream harness — Claude Code, Cursor, Hermes, Copilot, Gemini CLI — ships these defenses yet**, so this is a genuine differentiation lane.

## Decision

Adopt defense-in-depth at the content layer:

1. **Taint + fence** — `src/security/taint.ts`: mark `webFetch`/MCP/`bash`-stdout as untrusted in `ToolUseContext`; wrap it in a clearly-labelled "untrusted data — not instructions" block. Longer-term, route it through a **quarantined sub-agent** (the dual-LLM pattern, natural on the [ADR 0001](./0001-target-architecture.md)/§5 orchestrator).
2. **Egress allow-list** — `src/security/egress.ts`: enforced in `webFetch.ts` and the sandbox; block exfiltration to non-allowlisted hosts.
3. **Secret redaction** — `src/security/redact.ts`: scrub `.env`/key-shaped strings from context *and* the run ledger.

## Consequences

- **Positive:** closes the most dangerous real attack on the current build; strongly on-brand ("reliability you can audit" includes "can't be hijacked"); a feature no competitor ships.
- **Negative/cost:** taint-tracking adds plumbing through `ToolUseContext`; an over-aggressive egress list breaks legitimate fetches (needs config); injection is never fully solved — this reduces, not eliminates, risk.
- **Phasing:** taint+fence + egress + redaction are P1 and high-urgency given the open trifecta; dual-LLM quarantine is P2 (builds on §5).

## Alternatives considered

- **Rely on the OS sandbox alone.** Rejected: the sandbox bounds the process, not what tainted content persuades the agent to do with its *allowed* tools (e.g. an allowed `curl`).
- **Full CaMeL (restricted-Python + policy engine).** Deferred: powerful but heavy and unproven in production; adopt the dual-LLM subset first.

## References

See [`improvement-proposal.md` §11](../improvement-proposal.md#11-sources) — [S1] lethal trifecta (Willison), [S2] dual-LLM + CaMeL, [S3] blast-radius reduction (Sophos).
