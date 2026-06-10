# Changelog

All notable changes to Alfred are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) (0.x: minor = feature rounds, patch = fixes).

## [0.2.0] — 2026-06-10

Two optimization rounds: Claude Fable 5 enablement + long-horizon reliability,
then industry-best-practice parity (model-initiated delegation, native
structured outputs, server-side compaction). 773 tests.

### Added
- **Model capability catalog** (`src/config/modelCatalog.ts`): per-model
  context window, output ceiling, thinking mode, sampling-param support,
  effort/task-budget/structured-output/server-compaction support, and a
  capability tier — longest-prefix matched, conservative default for unknown
  ids. Every provider gates every parameter through it, so no configured
  model ever receives a parameter it would reject.
- **Adaptive thinking + effort**: on by default where supported; effort
  defaults per role (architect `xhigh`, editor `medium`, subagent `low`);
  `ALFRED_EFFORT` / `ALFRED_THINKING` overrides. Effort now translates on
  every provider: Anthropic `output_config.effort`, OpenAI `reasoning_effort`
  (+ `max_completion_tokens` on reasoning models), Gemini
  `thinkingConfig.thinkingBudget`.
- **Task budgets** (beta): the orchestrator's remaining token budget is
  surfaced to capable models so they wrap up gracefully instead of being cut
  off mid-task.
- **`spawn_subagent` tool**: model-initiated delegation to an isolated
  context (depth cap 1). `read_only: true` restricts to the non-mutating
  tool surface and dispatches in parallel. Sub-run usage/cost accrue to the
  parent; routed to the `subagent` role target.
- **Native structured outputs** on all three providers (Anthropic
  `output_config.format`, OpenAI `response_format`, Gemini `responseSchema`),
  with automatic fallback to the synthetic `structured_output` tool when the
  schema falls outside the strict subset or the model lacks support.
- **Server-side compaction** (beta `compact-2026-01-12`) on supporting
  Anthropic models: compaction blocks round-trip verbatim; local context
  editing/compaction stands down while active; `ALFRED_SERVER_COMPACT=0`
  opts out.
- **Fast verify pre-gate**: `alfred run --verify-fast <cmd>` /
  `ALFRED_VERIFY_FAST_CMD`. Failures short-circuit the fix loop; only the
  full gate can mark a feature passing. Verify events carry `gate: fast|full`.
- **Cross-provider role routing**: role slots accept `{provider, model}`
  (env: `ALFRED_MODEL_EDITOR=openai:gpt-5.2`); the fallback chain resolves
  the provider per target. `retrying` events carry `fromModel`/`toModel`.
- **Thinking-block fidelity**: thinking/redacted_thinking blocks round-trip
  verbatim through the transcript (required for tool loops under adaptive
  thinking); non-Anthropic serializers skip them.
- `claude-fable-5` pricing; harness iteration budget defaults from the
  implement model's capability tier (frontier 2 / strong 3 / small 4).

### Changed
- **Message-history cache breakpoints**: the last two user-role messages are
  cache-marked (4 breakpoints total with tools+system) — on long runs the
  bulk of input tokens now hits the ~0.1× cache-read price instead of being
  re-billed at full price every turn.
- Context ceiling and `max_tokens` defaults now derive from the model
  catalog instead of global constants (1M-context models are no longer
  compacted at 160K).
- Compaction summaries route to the cheapest configured role model.
- Prompt tuning for the Fable/Opus-4.8 lineage: autonomy fragment (small
  decisions don't ask), unattended-run instruction in the harness prompt,
  prescriptive trigger conditions on memory tool descriptions.

### Fixed
- `max_tokens` truncation is no longer reported as success: the loop asks
  the model to continue (bounded), then ends with terminal status
  `truncated`.
- `pause_turn` and `model_context_window_exceeded` stop reasons are handled
  (resume / forced compaction) instead of silently ending as success.
- Tool calls are dispatched on block presence rather than stop reason
  (tolerates OpenAI-compatible gateways returning `finish_reason: stop`
  alongside tool calls).
- Empty assistant turns are never appended (API rejects empty content).
- o-series/gpt-5 requests no longer carry `temperature`/`max_tokens`
  (which those models reject).

## [0.1.0] — baseline

Initial public architecture: agent loop (retry/fallback/streaming/typed
status), memory v2 (file-first + FTS5 + GC), orchestrator
(agent/parallel/pipeline + journal + budget + HMAC ledger), autonomous
harness (feature_list state machine + objective verify gate + rubric +
checkpoint/rollback + best-of-N), code intelligence (repo map, post-edit
syntax check, LSP), agent-layer security (taint fence, egress allow-list,
redaction, dual-LLM quarantine), observability (OTel GenAI spans, cost
tracker, eval harness), providers (Anthropic/OpenAI/Gemini + GLM via
compatible endpoint), extensibility (hooks, OS sandbox, MCP, skills).
