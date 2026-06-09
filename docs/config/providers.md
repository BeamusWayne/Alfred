# Providers

Alfred ships with two LLM provider backends and a URL-override seam that lets
you point either one at any Anthropic-compatible endpoint.

## Built-in providers

| Provider id | Environment variable | SDK / transport |
|-------------|---------------------|-----------------|
| `anthropic` | `ANTHROPIC_API_KEY` | `@anthropic-ai/sdk` (official SDK, streaming, prompt caching) |
| `openai` | `OPENAI_API_KEY` | Native `fetch` to `/v1/chat/completions` — no `openai` npm package required |
| `google` | `GOOGLE_API_KEY` (or `GEMINI_API_KEY`) | Native `fetch` to Gemini `v1beta/:generateContent` — faithful `functionCall`/`functionResponse` tool calling |

Select a provider:

```bash
# Default — uses Anthropic
alfred "…"

# OpenAI
ALFRED_PROVIDER=openai alfred "…"

# Google Gemini (defaults to the gemini-2.5-flash model)
ALFRED_PROVIDER=google GOOGLE_API_KEY=… alfred "…"
```

All three providers implement the same `Provider` interface (`src/providers/types.ts`);
no tool or engine code changes when you switch. Each provider has a sensible default
model (`claude-sonnet-4-6` / `gpt-4o` / `gemini-2.5-flash`), overridable with `-m` or
`ALFRED_MODEL`.

::: tip Gemini tool-schema compatibility
The Google provider rewrites each tool's JSON Schema down to the OpenAPI-3.0 subset
Gemini's function-declaration parser accepts — Zod-emitted constraints like
`exclusiveMinimum`, `format`, `pattern`, `$schema`, and `additionalProperties` are
dropped (Gemini rejects unknown keys). Tool `type`/`description`/`enum`/`properties`/
`required`/`items` are preserved.
:::

## Selecting a model

Model selection follows this precedence order (highest wins):

1. `-m/--model` CLI flag
2. `ALFRED_MODEL_<ROLE>` env var for role-specific calls
3. `ALFRED_MODEL` env var
4. Built-in default: `claude-sonnet-4-6`

```bash
# Override for a single run
alfred -m claude-opus-4-5 "Design the retry strategy"

# Set a persistent default
export ALFRED_MODEL=claude-haiku-4-5
```

## Anthropic-compatible endpoints via `ALFRED_BASE_URL`

The Anthropic provider accepts any base URL that speaks the Anthropic Messages
API. This covers hosted services (Bedrock, Vertex), self-hosted proxies, and
third-party compatible endpoints.

### Example: Zhipu GLM

Zhipu AI's **GLM** models expose an Anthropic-compatible endpoint:

```bash
export ALFRED_PROVIDER=anthropic
export ALFRED_BASE_URL=https://open.bigmodel.cn/api/anthropic
export ANTHROPIC_API_KEY=<your-zhipu-key>
export ALFRED_MODEL=glm-4-plus

alfred "Summarise the repo in one paragraph."
```

Alfred will use the `@anthropic-ai/sdk` client pointed at the GLM endpoint;
all features (streaming, prompt caching headers, tool use) work as long as the
endpoint supports them.

### `ALFRED_BASE_URL` vs `ANTHROPIC_BASE_URL`

| Variable | Priority | Used by |
|----------|----------|---------|
| `ALFRED_BASE_URL` | Higher | Both providers (Anthropic + OpenAI) |
| `ANTHROPIC_BASE_URL` | Lower (Anthropic only) | Anthropic provider only, as a fallback |

When both are set, `ALFRED_BASE_URL` wins.

## Role-based model routing (ADR 0005)

Alfred supports an **architect / editor / subagent** split: different roles
in the agent loop can use different models, enabling you to use a strong
reasoning model for planning and a cheaper model for mechanical edit
application.

### Configuring roles

```bash
# Strong model plans; fast model applies edits
export ALFRED_MODEL_ARCHITECT=claude-opus-4-5
export ALFRED_MODEL_EDITOR=claude-haiku-4-5
export ALFRED_MODEL_SUBAGENT=claude-haiku-4-5
```

Roles not listed fall back to `ALFRED_MODEL` (or the built-in default).

### Role definitions

| Role | When used |
|------|-----------|
| `architect` | Reasoning / planning turns — produces the implementation plan |
| `editor` | Mechanical edit application — turns the plan into `file_edit` calls |
| `subagent` | Delegated subtasks dispatched from the orchestrator |

### Fallback chain (retry escalation)

When a provider returns a retryable error (e.g. HTTP 429 or 529 overloaded),
the engine builds a **fallback chain** and advances to the next model instead
of retrying the same overloaded one indefinitely.

The chain order is deterministic (ADR 0005):

1. The resolved model for the current role (head of chain).
2. All other distinct models from the role map, in declaration order:
   `architect` → `editor` → `subagent`.
3. No duplicates; primary is always first.

Example with `ALFRED_MODEL=claude-sonnet-4-6`,
`ALFRED_MODEL_ARCHITECT=claude-opus-4-5`,
`ALFRED_MODEL_EDITOR=claude-haiku-4-5`:

```
architect call fallback chain:
  claude-opus-4-5 → claude-haiku-4-5 → claude-sonnet-4-6

editor call fallback chain:
  claude-haiku-4-5 → claude-opus-4-5 → claude-sonnet-4-6
```

::: tip Cost optimization
Set `ALFRED_MODEL_EDITOR=claude-haiku-4-5` to use the cheapest capable model
for the high-frequency edit-application turns, while keeping
`ALFRED_MODEL_ARCHITECT=claude-opus-4-5` for deep reasoning. This matches the
pattern recommended by ADR 0005 and aligns with the repo's token-budget rule.
:::

::: info OpenAI-compatible endpoints
`ALFRED_BASE_URL` is also checked by the OpenAI provider, so you can point the
OpenAI transport at any OpenAI-compatible endpoint (local Ollama, vLLM, etc.)
without changing provider code:

```bash
export ALFRED_PROVIDER=openai
export ALFRED_BASE_URL=http://localhost:11434/v1
export OPENAI_API_KEY=ollama   # required but ignored by many local servers
export ALFRED_MODEL=llama3.2
```
:::
