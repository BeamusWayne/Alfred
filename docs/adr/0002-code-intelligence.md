# ADR 0002 — Code intelligence: repo map + LSP

**English** | [中文](https://github.com/BeamusWayne/Alfred/blob/main/docs/adr/0002-code-intelligence.zh-CN.md)

- **Status:** Proposed
- **Date:** 2026-06-05
- **Relates to:** [ADR 0001](./0001-target-architecture.md) · [`improvement-proposal.md` §6.1](https://github.com/BeamusWayne/Alfred/blob/main/docs/improvement-proposal.md#61-code-intelligence--repo-understanding)

## Context

Alfred's only code-navigation tools are `glob` and `grep` (`src/tools/glob.ts`, `src/tools/grep.ts`) — pure text search with zero structural or semantic awareness. It cannot answer "where is this symbol defined/used," cannot surface types, and `src/tools/fileEdit.ts` can write syntactically broken code that is only caught later by `bun test` (if a test covers it). On a large repo the model greps blindly and burns turns.

The field has two complementary answers: Aider's **repo map** (tree-sitter `def`/`ref` tags → a symbol graph → **PageRank** into a fixed token budget) for cheap whole-repo structural awareness, and the **Language Server Protocol** (go-to-def, find-refs, hover types, diagnostics) for IDE-grade semantic precision (~50 ms call-site lookup vs tens of seconds of recursive grep). Hermes Agent is independently adding both (issues #535, #516).

## Decision

Add a code-intelligence layer in three steps:

1. **Repo map** — `src/context/repomap.ts`: tree-sitter (`web-tree-sitter`) + PageRank into a token budget, injected adjacent to memory Core ([ADR 0001](./0001-target-architecture.md)/§4).
2. **Post-edit tree-sitter syntax check** — in `src/tools/fileEdit.ts`: reject an edit whose result does not parse. Cheap; kills a whole class of failures before the verify loop.
3. **LSP client** — `src/tools/lsp/`: a thin JSON-RPC client exposing `definition`/`references`/`hover`/`diagnostics` as tools, feeding diagnostics into the harness verify loop.

## Consequences

- **Positive:** fewer hallucinated/broken edits (correctness); the model explores confidently because exploration is cheap; diagnostics are a faster gate than a full test run.
- **Negative/cost:** tree-sitter grammars and an LSP client add dependencies and per-language wiring; the repo map needs cache invalidation on file change.
- **Phasing:** post-edit parse check is P0-adjacent (S); repo map P1 (M); LSP client P2 (M→L).

## Alternatives considered

- **Embeddings index (Cursor-style).** Rejected as the default: heavier infra, less inspectable than a deterministic symbol graph; reconsider only if PageRank proves insufficient.
- **Stay grep-only.** Rejected: the measured correctness gap is large and the repo-map cost is modest.

## References

See [`improvement-proposal.md` §11](https://github.com/BeamusWayne/Alfred/blob/main/docs/improvement-proposal.md#11-sources) — [CI1] Aider repo map, [CI2] LSP for agents / Kiro, [CI3] LSAP & tree-sitter-vs-LSP, [CI4] Hermes #535/#516.
