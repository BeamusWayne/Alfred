# Observability

Alfred's reliability thesis requires provable measurement. The observability layer delivers three things: **OpenTelemetry GenAI spans** that any backend can render, a **cost tracker** that maintains immutable per-model USD accounting, and an **eval harness** that replays recorded trajectories through the real engine to gate regressions. This is specified in [ADR 0004](/adr/0004-observability-and-evals).

---

## OTel GenAI Spans

**Source:** `src/telemetry/otel.ts`

Alfred emits spans shaped to the [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) so any backend (Datadog, Honeycomb, Langfuse, LangSmith) can render agent traces without bespoke adapters.

### Design principles

- **Zero-cost by default.** The default exporter is a `NoopExporter` that discards spans with no I/O. Tracing is opt-in via `ALFRED_OTEL_FILE`.
- **Pure immutable data.** Spans are plain readonly objects; `SpanHandle.setAttribute()` returns a new handle (builder pattern). Span data is never mutated after `end()`.
- **Fully injectable.** The clock (`now`) and ID generator (`nextId`) are injectable for deterministic tests.

### Attribute key constants

All `gen_ai.*` keys are exported as typed constants:

| Constant | Wire key | Used for |
|---|---|---|
| `GEN_AI_OPERATION_NAME` | `gen_ai.operation.name` | Operation type: `"chat"`, `"execute_tool"`, `"invoke_agent"` |
| `GEN_AI_SYSTEM` | `gen_ai.system` | Provider name (e.g. `"anthropic"`) |
| `GEN_AI_REQUEST_MODEL` | `gen_ai.request.model` | Model identifier used for the request |
| `GEN_AI_USAGE_INPUT_TOKENS` | `gen_ai.usage.input_tokens` | Input token count from the provider |
| `GEN_AI_USAGE_OUTPUT_TOKENS` | `gen_ai.usage.output_tokens` | Output token count from the provider |
| `GEN_AI_TOOL_NAME` | `gen_ai.tool.name` | Tool name for `execute_tool` spans |

### Span hierarchy emitted by the query engine

```
invoke_agent  [gen_ai.operation.name, gen_ai.request.model]
  ├── chat    [gen_ai.system, gen_ai.request.model,
  │            gen_ai.usage.input_tokens, gen_ai.usage.output_tokens]
  ├── chat    (subsequent turns)
  └── execute_tool  [gen_ai.operation.name, gen_ai.tool.name]
       └── execute_tool  (parallel tool calls share the same parent agentSpan)
```

`chat` spans record token counts via `setAttribute` after the response lands. `execute_tool` spans set status to `"error"` when `result.isError` is true.

### `Tracer` API

```ts
const tracer = tracerFromEnv();   // reads ALFRED_OTEL_FILE; returns no-op tracer if unset

const span = tracer.startSpan(
  "invoke_agent",
  { [GEN_AI_OPERATION_NAME]: "invoke_agent", [GEN_AI_REQUEST_MODEL]: "claude-sonnet-4-6" },
  parentSpan,                     // optional — sets parentId on the child span
);

span.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, 1234);
span.setStatus("ok");
span.end();                       // serialises the immutable Span and pushes it to the exporter
```

`SpanHandle` is a builder: `setAttribute` and `setStatus` return `this` for chaining.

### Exporters

**`NoopExporter`** — default; `export()` is a no-op.

**`FileExporter(path)`** — appends completed spans as OTLP-style JSONL to `path`. Concurrent `end()` calls are serialised through a `writeQueue` promise chain so lines never interleave.

**`tracerFromEnv(options?)`** — factory that reads `ALFRED_OTEL_FILE`:
- If set, creates a `FileExporter` for that path.
- If absent or empty, creates a `NoopExporter`.

### Enabling file export

```bash
ALFRED_OTEL_FILE=alfred-trace.jsonl alfred run "fix the test failures"
```

Each line of the file is a JSON-serialised `Span` object. Feed it to any OTLP-compatible collector or visualise it locally.

---

## Cost Tracker

**Source:** `src/cost/tracker.ts`

`CostTracker` maintains an immutable per-model accumulation of token usage and USD cost. `add()` always returns a **new** tracker — the original is never mutated.

### Pricing table

`PRICING_TABLE` is the single source of truth for model costs (USD per 1 million tokens):

| Model | Input | Output | Cache read | Cache write |
|---|---|---|---|---|
| `claude-haiku-4-5` | $1.00 | $5.00 | $0.10 | $1.25 |
| `claude-sonnet-4-6` | $3.00 | $15.00 | $0.30 | $3.75 |
| `claude-opus-4-6` | $5.00 | $25.00 | $0.50 | $6.25 |
| `claude-opus-4-7` | $5.00 | $25.00 | $0.50 | $6.25 |
| `claude-opus-4-8` | $5.00 | $25.00 | $0.50 | $6.25 |
| `glm-4.5` | $0.60 | $2.20 | $0.11 | $0.75 |
| `glm-4.6` | $0.60 | $2.20 | $0.11 | $0.75 |
| `glm-5.1` | $0.60 | $2.20 | $0.11 | $0.75 |

Unrecognised model IDs fall back to Sonnet pricing (`$3.00` / `$15.00`). `PRICING_TABLE` is exported and readonly; callers can extend it without mutating the original using spread: `{ ...PRICING_TABLE, "my-model": { … } }`.

### API

```ts
let cost = new CostTracker();

// After each model turn in the query engine:
cost = cost.add(response.model, response.usage);

// Aggregate totals:
const { usd, usage } = cost.total();
// usd: number, usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }

// Per-model breakdown (sorted by model name):
const breakdown: readonly ModelRecord[] = cost.byModel();
// ModelRecord: { model, usage, usd }

// Custom pricing table for tests or new models:
const tracker = CostTracker.withPricing({ ...PRICING_TABLE, "my-preview": { … } });
```

The query engine creates a fresh `CostTracker` per `runQuery` call and accumulates cost via `cost = cost.add(…)` after every chat turn. The final `cost.total()` is included in the returned `QueryState`.

---

## Eval Harness

**Sources:** `src/eval/types.ts`, `src/eval/runner.ts`

The eval harness replays recorded agent trajectories through the **real** query engine and asserts no regressions. Only the provider is mocked — the full permission evaluator, tool stack, taint fencing, and hook system execute as in production.

### Core types

**`EvalCase`** — a single reproducible test case:

```ts
interface EvalCase {
  readonly name: string;
  readonly prompt: string;
  /** Ordered MockProvider scripts that define the recorded trajectory. */
  readonly scripts: readonly Script[];
  readonly expect: EvalExpectation;
}
```

**`EvalExpectation`** — assertions to check (all fields optional; omitting skips that assertion):

```ts
interface EvalExpectation {
  /** Terminal status the loop must produce. */
  readonly status?: "success" | "max_turns" | "provider_error" | "aborted";
  /** Every tool in this list must appear in observed tool_use events, in order. */
  readonly toolsUsed?: readonly string[];
  /** Total tool_use event count must not exceed this. */
  readonly toolCallCountAtMost?: number;
  /** Each string must appear as a substring of the final assistant text. */
  readonly finalTextIncludes?: readonly string[];
}
```

**`EvalResult`** — outcome of one case:

```ts
interface EvalResult {
  readonly name: string;
  readonly passed: boolean;
  readonly failures: readonly string[];  // human-readable, empty when passed
  readonly toolsUsed: readonly string[]; // tool names in call order
  readonly status: QueryState["status"];
  readonly turns: number;
}
```

**`EvalReport`** — aggregated suite outcome: `{ total, passed, failed, results }`.

### Running evals

```ts
import { runEvalCase, runEvalSuite, formatReport } from "./src/eval/runner.ts";

// Single case
const result = await runEvalCase(myCase);

// Full suite (sequential — MockProvider state is isolated per case)
const report = await runEvalSuite(myCases);
console.log(formatReport(report));
// Output: "Eval: 4/5 passed (1 failed)"
//         "  ✓ reads file before editing  [status=success, turns=3, tools=2]"
//         "  ✗ handles missing file       [status=success, turns=2, tools=1]"
//         "      - finalTextIncludes: expected substring "not found" not found in "…""
```

### Assertion details

**`toolsUsed` ordering** — the check requires the expected tools to appear as an ordered subsequence of the observed calls (not necessarily consecutive). For example, `expect.toolsUsed = ["file_read", "file_edit"]` passes if `file_read` appears at any point before `file_edit`, regardless of other tools in between.

**`toolCallCountAtMost`** — a ceiling on total `tool_use` events, useful for asserting that a solution does not loop unnecessarily.

**`finalTextIncludes`** — checks that each expected substring appears in the concatenated text from all `"text"` events (the full assistant response).

Human-readable failure descriptions pinpoint exactly what was wrong, including the expected value, the observed value, and relevant context (e.g. the full tool call list or a 120-character preview of the final text).
