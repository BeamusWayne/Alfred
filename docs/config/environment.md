# Environment Variables

Alfred is configured entirely through environment variables and CLI flags. This
page is the exhaustive reference for every `process.env.*` read by the
codebase. The table below was compiled by grepping all `.ts` source files for
`process.env.` — no variable is omitted.

## Full variable table

| Variable | Default | Effect | Read in |
|----------|---------|--------|---------|
| `ALFRED_PROVIDER` | `"anthropic"` | Selects the LLM provider. The only accepted non-default value is `"openai"`; anything else falls back to `"anthropic"`. | `src/config/manager.ts` |
| `ALFRED_MODEL` | `"claude-sonnet-4-6"` | Default model id for all roles when no role-specific override is set. Overridden by the `-m/--model` CLI flag. | `src/config/manager.ts` |
| `ALFRED_BASE_URL` | _(none)_ | Override the provider API base URL. Useful for Anthropic-compatible endpoints (e.g. Zhipu GLM). Checked by both the Anthropic and OpenAI provider constructors. When set, takes precedence over `ANTHROPIC_BASE_URL`. | `src/config/manager.ts`, `src/providers/anthropic.ts` |
| `ALFRED_MODEL_ARCHITECT` | _(none)_ | Model id for the architect role (planning / reasoning). Falls back to `ALFRED_MODEL` when absent. | `src/config/manager.ts` |
| `ALFRED_MODEL_EDITOR` | _(none)_ | Model id for the editor role (mechanical edit application). Falls back to `ALFRED_MODEL` when absent. | `src/config/manager.ts` |
| `ALFRED_MODEL_SUBAGENT` | _(none)_ | Model id for delegated subagent tasks. Falls back to `ALFRED_MODEL` when absent. | `src/config/manager.ts` |
| `ALFRED_MEMORY` | _(unset = disabled)_ | Set to any truthy value (e.g. `"1"`) to enable memory injection and garbage-collection on session end (ADR 0001 §4). Memory files live under `.alfred/memory/`. | `src/index.ts` |
| `ALFRED_REPOMAP` | _(unset = disabled)_ | Set to any truthy value (e.g. `"1"`) to inject a repository map into the system prompt on each run (ADR 0002). | `src/index.ts` |
| `ALFRED_SANDBOX` | _(unset = disabled)_ | Set to `"1"` to wrap every `bash` tool call with macOS `sandbox-exec` (Seatbelt). Denies network access and restricts writes to the working directory and `/tmp`. No-op on non-Darwin platforms. | `src/tools/bash.ts` |
| `ALFRED_OTEL_FILE` | _(none)_ | Absolute or relative path to a JSONL file for OpenTelemetry GenAI spans. When unset, the tracer is a no-op and there is no I/O cost (ADR 0004). | `src/telemetry/otel.ts` |
| `ALFRED_EGRESS_ALLOW` | _(deny-all)_ | Comma-separated list of hostnames the `web_fetch` tool is allowed to contact. When absent or empty, all outbound HTTP is denied. Example: `"api.example.com,cdn.example.com"`. | `src/tools/webFetch.ts` |
| `ALFRED_LEDGER_SECRET` | `"alfred-dev-insecure-secret-change-me"` | HMAC-SHA-256 key used to sign ledger rows in `alfred run`. Change this to a strong random secret before using Alfred in production; the default is intentionally weak and publicly known. | `src/index.ts` |
| `ALFRED_VERIFY_CMD` | `"bun test"` | Default verify shell command for `alfred run` when `--verify` is not passed. | `src/index.ts` |
| `ANTHROPIC_API_KEY` | _(required for anthropic provider)_ | Anthropic API key. Alfred warns on stderr if this is unset when `ALFRED_PROVIDER=anthropic`. Also read directly by the `@anthropic-ai/sdk` client. | `src/index.ts`, `src/providers/anthropic.ts` |
| `ANTHROPIC_BASE_URL` | _(none)_ | Fallback base URL for the Anthropic provider. `ALFRED_BASE_URL` takes precedence when both are set. | `src/providers/anthropic.ts` |
| `OPENAI_API_KEY` | _(required for openai provider)_ | OpenAI (or compatible) API key. Alfred warns on stderr if unset when `ALFRED_PROVIDER=openai`. | `src/index.ts`, `src/providers/openai.ts` |

## Precedence rules

For model selection, the resolution order (highest to lowest priority) is:

1. `-m/--model` CLI flag
2. `ALFRED_MODEL_<ROLE>` (for role-specific calls)
3. `ALFRED_MODEL`
4. Built-in default (`claude-sonnet-4-6`)

For the provider base URL:

1. `ALFRED_BASE_URL`
2. `ANTHROPIC_BASE_URL` (Anthropic provider only)
3. SDK default (`https://api.anthropic.com`)

## Opt-in features summary

The following features are **disabled by default** and require an env var to
activate:

```bash
# Memory — extract + GC on session end
export ALFRED_MEMORY=1

# Repo map — inject directory tree into system prompt
export ALFRED_REPOMAP=1

# OS sandbox — macOS seatbelt around bash (darwin only)
export ALFRED_SANDBOX=1

# OTel tracing — write spans to a JSONL file
export ALFRED_OTEL_FILE=./alfred-traces.jsonl

# Egress allow-list — permit web_fetch to specific hosts
export ALFRED_EGRESS_ALLOW="api.github.com,raw.githubusercontent.com"
```

::: warning Change the ledger secret in production
The default `ALFRED_LEDGER_SECRET` is public. Any run using the default secret
is signed but not secret — anyone who knows the default can forge entries.

```bash
export ALFRED_LEDGER_SECRET="$(openssl rand -hex 32)"
```
:::

::: tip Minimal setup for a one-shot run
```bash
export ANTHROPIC_API_KEY="sk-ant-…"
alfred "Explain src/orchestrator/ledger.ts"
```
:::

::: tip Minimal setup for `alfred run`
```bash
export ANTHROPIC_API_KEY="sk-ant-…"
export ALFRED_LEDGER_SECRET="$(openssl rand -hex 32)"
alfred run
```
:::
