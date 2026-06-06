# Agent Loop

The agent loop is the engine that drives every interaction: a single user message enters, the model responds, tools may be called, and the process repeats until the model signals completion or a hard limit is reached. The entire loop is exposed as an async generator (`runQuery`) that yields discrete, typed `QueryEvent` values and returns a final `QueryState` when it terminates.

**Source files:** `src/query/engine.ts`, `src/query/types.ts`, `src/query/retry.ts`, `src/compact/engine.ts`, `src/compact/tokens.ts`, `src/providers/types.ts`.

---

## Overview

```text
runQuery(userMessage, config)
  │
  ├─ [each turn]
  │    ├─ shouldCompact? → compact() (user boundary)
  │    ├─ chatWithRetry()
  │    │    ├─ fallbackChain → pick model
  │    │    ├─ provider.stream() OR provider.chat()
  │    │    │    └─ yield { type: "text", text }   (incremental or whole)
  │    │    └─ on retryable error: yield { type: "retrying" }, sleep, escalate chain
  │    │
  │    ├─ stopReason === "end_turn" → yield done / return finish("success")
  │    └─ stopReason === "tool_use"
  │         ├─ parallel tools   → Promise.all(executeTool)
  │         └─ serial tools     → await executeTool (one at a time)
  │
  └─ turns >= maxTurns → yield done / return finish("max_turns")
```

---

## `runQuery`: the async-generator loop

`runQuery` in `src/query/engine.ts` is an `AsyncGenerator<QueryEvent, QueryState>`. Callers iterate it with `for await` (REPL) or drain it in `runAgent` (orchestrator). The generator returns (not yields) its final `QueryState` on the generator's `return` slot.

### Defaults

| Config field | Default |
|---|---|
| `maxTurns` | 50 |
| `maxRetries` | 5 |
| `maxContextTokens` | 200,000 |

### Turn structure

Each turn of the `while (turns < maxTurns)` loop:

1. Check `signal.aborted` — return `finish("aborted")` immediately if cancelled.
2. Call `shouldCompact` — trigger `compact()` if near the token budget (see [Context Compaction](#context-compaction)).
3. Open a `chat` OTel span and call `chatWithRetry`. Text events are yielded from inside `chatWithRetry` as they arrive.
4. After the span closes, accumulate `usage` via `addUsage` and update the `CostTracker`.
5. Push the assistant's response to `messages`.
6. If `stopReason !== "tool_use"`, yield `{ type: "done", status: "success" }` and return.
7. Otherwise, split tool calls into `parallel` (read-only AND concurrency-safe) and `serial` groups, execute them, yield events, and push results.

---

## `QueryEvent` and `QueryState` types

### `QueryEvent` — the stream of progress

Defined in `src/query/types.ts`:

| `type` | Fields | Meaning |
|---|---|---|
| `text` | `text: string` | A chunk of model text (delta from stream, or whole block from non-streaming) |
| `tool_use` | `id`, `name`, `describe`, `input` | A tool call the model is making |
| `tool_result` | `id`, `name`, `output`, `isError` | The outcome of that tool call |
| `retrying` | `attempt`, `delayMs`, `reason` | A retry is about to happen (provider failure) |
| `error` | `message` | A non-retriable error or max-turns breach |
| `done` | `status: TerminalStatus` | The loop has ended |

### `TerminalStatus` — how the loop ended

```ts
type TerminalStatus = "success" | "max_turns" | "provider_error" | "aborted";
```

Callers use this to distinguish a natural completion from a limit hit or failure without inspecting error strings.

### `QueryState` — the final return value

```ts
interface QueryState {
  readonly messages: readonly Message[];
  readonly turns: number;
  readonly usage: Usage;
  readonly status: TerminalStatus;
  readonly cost?: { readonly usd: number; readonly usage: Usage };
}
```

`cost` is populated once the loop has executed at least one model call. `usage` accumulates across all turns using `addUsage`.

---

## Token streaming vs. whole-text emission

The provider abstraction (`src/providers/types.ts`) exposes two call modes:

- `provider.stream(...)` — optional; returns an `AsyncGenerator<StreamEvent, LLMResponse>` where `StreamEvent` is `{ type: "text_delta"; text: string }`.
- `provider.chat(...)` — required; returns `LLMResponse` directly.

`chatWithRetry` checks `config.provider.stream` at runtime:

```ts
if (config.provider.stream) {
  // Yield incremental text_delta events directly to the caller.
  const gen = config.provider.stream(messages, toolDefs, providerConfig, { signal });
  ...
  // Each text_delta with length > 0 becomes a { type: "text", text } event.
} else {
  // Non-streaming: wait for the full response, then emit each text block once.
  const response = await config.provider.chat(...);
  for (const block of response.content) {
    if (block.type === "text" && block.text.length > 0) {
      yield { type: "text", text: block.text };
    }
  }
}
```

From the caller's perspective, `{ type: "text" }` events look identical in both paths; only the latency pattern differs.

---

## Retry and the model fallback chain (`chatWithRetry`)

`chatWithRetry` (`src/query/engine.ts`) owns retries and model escalation. It is itself an async generator so it can `yield { type: "retrying" }` events before sleeping.

### Retry eligibility

Defined in `src/query/retry.ts`:

```ts
function isRetryable(err: unknown): boolean {
  return err instanceof ProviderError && err.retryable;
}
```

Only `ProviderError` instances with `retryable: true` trigger a retry. Non-retryable errors (e.g., auth failures) propagate immediately.

### Backoff

```ts
function computeDelay(attempt: number, retryAfter?: number): number {
  if (retryAfter !== undefined) return retryAfter;
  const base = 200 * 2 ** (attempt - 1);
  return Math.round(base + base * 0.25 * Math.random());
}
```

Exponential with ±25 % jitter, starting at 200 ms. If the provider includes a `Retry-After` header (surfaced as `ProviderError.retryAfterMs`), that value is used verbatim.

### Fallback chain

On the first retryable failure, `chatWithRetry` increments `chainIdx` and picks the next model from `fallbackChain(config.model, config.roles, config.role)` (from `src/config/roles.ts`). Subsequent retries continue down the chain rather than hammering the same overloaded endpoint. If the chain is exhausted, the same last model is reused.

### Abort-aware sleep

`sleep(ms, signal)` in `retry.ts` rejects immediately if `signal.aborted`, so an in-flight backoff delay is cancelled within one event-loop tick of the user pressing Escape.

---

## Context compaction (user boundary)

At the top of each turn, `runQuery` calls:

```ts
if (shouldCompact(messages, { maxContextTokens })) {
  const compacted = await compact(messages, { provider, model, maxContextTokens });
  ...
}
```

### Token estimation

`src/compact/tokens.ts` provides `estimateTokens(text)` and `estimateMessages(messages)`. The heuristic is 1 token ≈ 4 UTF-16 code units (`Math.ceil(text.length / 4)`), matching Anthropic's own tooling.

### Trigger threshold

`shouldCompact` fires when the estimated message token count exceeds `threshold × maxContextTokens`. The default threshold is **0.80** (80 %).

### Split and summarise

`compact` (`src/compact/engine.ts`) finds a split point at a **user-message boundary** so no `tool_use`/`tool_result` pair is severed. By default it keeps the 6 most recent messages verbatim.

The older portion is serialised to a human-readable excerpt (USER/ASSISTANT/TOOL_RESULT prefixes) and sent to the model with a dedicated system prompt (`SUMMARISATION_SYSTEM`). The model's response text becomes a synthetic `UserMessage` prepended to the recent tail:

```text
[Context summary — earlier conversation compacted]

<summary text>
```

Compaction is **best-effort**: if the provider call fails, the original message list is returned unchanged. The outer loop never crashes.

---

## Parallel vs. serial tool execution

When `stopReason === "tool_use"`, the engine partitions tool calls:

```ts
const parallel = uses.filter((u) => isParallelizable(tools, u));
const serial   = uses.filter((u) => !isParallelizable(tools, u));
```

`isParallelizable` requires both `tool.isReadOnly(data) === true` **and** `tool.isConcurrencySafe(data) === true`. If either flag is false, the tool runs serially.

Parallel tools run via `Promise.all`. Serial tools run one at a time in the order the model returned them, with each result appended to `messages` before the next call.

### Tool execution (`executeTool`)

For each tool use, `executeTool`:

1. Looks up the tool by name; unknown name → error result (no throw).
2. Validates input with Zod `safeParse`; invalid input → error result.
3. Runs **PreToolUse hooks** — may block the call or rewrite the input.
4. Calls `evaluatePermission` — may deny or trigger an approval callback (`ApprovalRequest`).
5. Starts an OTel `execute_tool` span.
6. Calls `tool.call(finalInput, ctx)`.
7. If `result.untrusted` is true, wraps output with `fence()` from `src/security/taint.ts` so the model treats it as data, not instructions (ADR 0003).
8. Runs **PostToolUse hooks** (best-effort; errors are swallowed).
9. Returns a `ToolOutcome` with `output` and `isError`.

---

## OTel spans and per-run cost

Every `runQuery` invocation opens a top-level `invoke_agent` span (attribute: `gen_ai.operation.name = "invoke_agent"`). Each model call opens a child `chat` span with input/output token counts set on close. Each tool execution opens a `execute_tool` span.

The tracer is a no-op unless `ALFRED_OTEL_FILE` is set in the environment.

Costs are tracked via `CostTracker` (immutable — each `add()` returns a new instance). The final `QueryState.cost` field carries `{ usd, usage }` for the entire run.

---

## `QueryConfig` reference

```ts
interface QueryConfig {
  provider: Provider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  maxTurns?: number;           // default 50
  permissions: ToolPermissionContext;
  tools?: readonly Tool[];     // default: all enabled built-in tools
  approve?: (req: ApprovalRequest) => Promise<boolean>;
  signal?: AbortSignal;
  maxRetries?: number;         // default 5
  maxContextTokens?: number;   // default 200,000
  roles?: RoleModelMap;        // for fallback chain (ADR 0005)
  role?: Role;
  hooks?: HooksConfig;         // PreToolUse / PostToolUse
}
```

---

## See also

- [Orchestrator](/subsystems/orchestrator) — how `runAgent` wraps `runQuery` for multi-step workflows
- [Harness](/subsystems/harness) — the autonomous feature loop built on the orchestrator
- [Memory](/subsystems/memory) — the memory system injected via `QueryConfig.systemPrompt`
