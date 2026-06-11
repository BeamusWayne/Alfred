# Changelog

All notable changes to Alfred are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) (0.x: minor = feature rounds, patch = fixes).

## [Unreleased]

### Added
- **`alfred init` provider setup** — on a TTY, init now also asks for the
  endpoint, API key (masked input, never echoed) and default model, and
  writes them to the project `.env` (chmod 600, auto-added to `.gitignore`),
  which Bun auto-loads for every alfred invocation from that directory.
  Empty answers keep existing values; rerunning `alfred init` on an
  already-initialized project reconfigures credentials without touching the
  feature list.

## [0.4.0] — 2026-06-11

The live-panel round: the dead air during a run is gone.

### Added
- **Real-time tool beats** — the runtime journals tool-level `activity`
  rows the moment each call starts (label/name/describe only; never tool
  input or output payloads). `alfred run` and `alfred watch` render them
  live (`  ⚙ read(add.test.ts)`), so a two-minute agent step shows its work
  instead of silence. Resume (`findByKey`) is blind to these rows, and
  replaying a finished run shows the same beats — including the rubric's
  `structured_output` beat landing and the run ending right there.
- **Sticky footer** on `alfred run` and `alfred watch` (TTY): progress bar ·
  n/m features · elapsed · spend, plus the current action — redrawn in place
  beneath a normally-scrolling event stream. Cursor-up repaint, no alternate
  screen: scrollback survives, and there are still zero new dependencies.
- `runAgent` gained an `onEvent` tap — live engine events for callers that
  want progress; the run still resolves to a single `AgentRun`.

### Changed
- Off-TTY `alfred run` keeps the one-line-per-harness-event contract (CI
  logs stay quiet); `alfred watch` shows beats everywhere — asking for them
  is its job.

### Internal
- Docs homepage StatusStrip is now measured at build time (version and
  runtime deps from package.json, test count from actually running the
  suite) instead of hand-maintained. 867 tests (+14).

## [0.3.1] — 2026-06-11

### Fixed
- `alfred run` without a `feature_list.json` now fails at the front door —
  the missing path plus the three ways forward (`alfred init`,
  `--feature-list <path>`, `alfred demo`) — instead of a raw
  `loadFeatureList` stack trace. Hit by the first `bun install -g` user
  minutes after 0.3.0 shipped.

## [0.3.0] — 2026-06-11

The CLI UX round: the front door, the run-time face, and the post-run audit.
The product is still the unattended run — these surfaces get you into it, keep
it legible, and make its receipts usable.

### Added
- **Thin REPL** — bare `alfred` on a TTY opens an interactive session:
  multi-turn (engine-native via `QueryConfig.initialMessages`), interactive
  tool approval, `/status` `/clear` `/cost` `/help`, session cost on exit.
  A porch, not a TUI — by design.
- **Interactive tool approval** — the permission stack's `ask` now really
  asks on a TTY (`[y/N/a]`, with per-tool "always" for the session). `--yes`
  stays the headless bypass. Previously the CLI had no approver, so `ask`
  always denied.
- **`alfred demo`** — the zero-key offline proof, now built into the npm
  package: scaffolds a RED sandbox, shows the gate fail, lets the scripted
  model drive the REAL harness to green, verifies the signed ledger, then
  flips one byte in a copy and shows the tamper caught. `bunx alfred-agent
  demo` works with no clone and no key.
- **`alfred why [runId]`** — explain a run from its own receipts (ledger +
  journal): which features blocked, verify exit codes, rubric verdicts and
  reasoning, with paths to the evidence. `--json` for machines.
- **`alfred ledger show [path] [--md]`** — render a receipt as a table;
  `--md` is paste-ready for PR descriptions.
- **`alfred init`** — scaffold `feature_list.json` (+ a `.gitignore` entry)
  with the exact next commands.
- **`alfred status`** (also what bare `alfred` prints off-TTY) — provider/key,
  feature_list counts, last run, and contextual next steps.
- **`alfred completion bash|zsh`**.
- **Human-readable `alfred run` progress** by default (one line per harness
  event, `terraform apply` style); `--json` keeps the raw event stream on
  stdout for machines.
- **`alfred watch [path]`** — a read-only live panel over a run's on-disk
  record: tail-follows `journal.jsonl` + `ledger.jsonl`, one line per
  agent/feature event, sticky status line (elapsed · features · spend).
  Attach from a second terminal — even before the run's first write — or
  replay a finished run; exits 0 once `run_end` lands. The panel renders the
  same files the ledger signs: watching is reading the receipt as it is
  written.
- `echo "question" | alfred -p` — print mode reads the prompt from stdin.
- `NO_COLOR` honoured across every surface.

### Changed
- A missing API key now fails at the front door with the exact `export` line
  and the keyless alternative (`alfred demo`) instead of warning and then
  dying inside the SDK.
- **Exit-code contract**: 0 success · 1 failure / not found · **2 tampered**
  (`ledger verify` and `ledger show`). Tamper previously exited 1.
- The README demo GIF is re-recorded with the human run renderer, and
  `docs/demo.tape` now binds `alfred` to the checked-out source so a regen
  always records the current code.

### Fixed
- **Schema runs end when the verdict lands** (`ToolResult.endsRun`): the
  synthetic `structured_output` tool now declares the run complete — the
  engine records the full tool batch (the transcript stays provider-valid),
  then ends with success instead of letting the model wander to `max_turns`.
  Caught live by `alfred watch` on its first dogfood: a glm-4.7 rubric judge
  burned 50 turns ($0.0537, 30x the implement cost) after its verdict was
  already captured — now 3 turns ($0.0011). Invalid payloads still bounce
  back for a retry (the schema gate precedes the tool call).
- **Receipts keep their `gitSha`**: the redactor treats any 40+ hex chars as
  key material, so feature rows' checkpoint pointer was stored as
  `[REDACTED:hex-blob]` — a signed receipt that cannot point at its
  checkpoint. `gitSha` is now exempt when (and only when) the value is
  shaped exactly like a commit hash (40/64 lowercase hex); anything else
  under that key, and hex blobs under every other key, are scrubbed as
  before.
- **glm-4.7 priced**: model ids missing from the pricing table fell back to
  Sonnet-tier defaults — GLM runs recorded ~5x their real cost.

### Internal
- CLI plumbing extracted to `src/cli/` (session, colors, approve, status,
  renderRun, repl, demo, init, why, ledgerShow, completion, watch); the
  engine gained `initialMessages` and `ToolResult.endsRun`. 853 tests (+56).

## [0.2.2] — 2026-06-11

First npm release, published as
[`alfred-agent`](https://www.npmjs.com/package/alfred-agent) (the bare name
`alfred` is squatted on npm). Install with `bun install -g alfred-agent` or
run one-shot via `bunx alfred-agent` — the command is still `alfred`.
Requires Bun ≥ 1.3: the source uses Bun APIs directly and ships as
TypeScript; there is no Node build.

### Added
- **Zero-key offline demo** (`bun run demo`, `bun run demo:verify`): a
  scripted mock model (`ALFRED_MOCK_SCRIPTS`) drives the real harness
  end-to-end — engine, tools, verify gate and signed run ledger all execute
  for real, with no API calls. `examples/demo/` ships RED (failing test);
  the run implements the feature, the gate captures exit 0, and the ledger
  verifies.
- **`alfred ledger verify` subcommand**: verifies a run ledger's hash chain
  and head anchor (newest run by default, or an explicit path). See
  `docs/cli/ledger.md`.
- npm package metadata: `files` whitelist (the tarball ships `src/`, the
  changelog, and `feature_list.example.json` only), `repository` /
  `homepage` / `bugs` / `keywords` / `author`, and a `prepublishOnly` gate
  (typecheck + full test suite).
- Docs site favicon (A-monogram with the verify-gate crossbar) and Open
  Graph / Twitter social card; README and repo metadata now point at the
  live docs site.

## [0.2.1] — 2026-06-10

Patch release: three bugs found by live multi-provider validation (GLM-5.1
and Gemini 3.1 Pro both complete the end-to-end bench 2/2 dual-pass on this
version; v0.2.0 cannot run Gemini 3.x tool loops).

### Fixed
- **Gemini 3.x thought-signature round-trip**: the API returns
  `thoughtSignature` on functionCall parts and hard-rejects later requests
  whose echoed history lost them. `ToolUseBlock` gains an opaque
  `providerMeta` field; the Google provider captures the signature on parse
  (chat + stream) and echoes it verbatim on serialise. `thought: true`
  reasoning parts no longer leak into visible text. 2.5-family serialisation
  is unchanged.
- **`ALFRED_BASE_URL` scoped to the anthropic provider**: a `.env` pinning it
  to an Anthropic-compatible endpoint (Zhipu GLM) used to poison Gemini
  request URLs. The Google provider's scoped override is `GEMINI_BASE_URL`.
- **Evidence-backed rubric judge**: schema mode now keeps caller-supplied
  tools alongside `structured_output`, and the harness gives the rubric judge
  read-only file access (glob/file_read/grep). Previously a strict judge with
  zero evidence (successful verify output can be empty) scored objectively
  passing implementations 0 and blocked them.

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
