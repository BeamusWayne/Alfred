# Using Zhipu GLM (and Other Anthropic-Compatible Endpoints)

Alfred's Anthropic provider reads `ALFRED_BASE_URL` (or `ANTHROPIC_BASE_URL`)
to point the Messages API at any compatible endpoint. Zhipu's GLM models expose
exactly that interface, so switching is a two-variable change with no code
edits.

## How it works

`src/providers/anthropic.ts` constructs the Anthropic SDK client with:

```ts
new Anthropic({
  apiKey: config.apiKey ?? process.env.ANTHROPIC_API_KEY,
  baseURL: config.baseUrl ?? process.env.ALFRED_BASE_URL ?? process.env.ANTHROPIC_BASE_URL,
})
```

When `ALFRED_BASE_URL` is set to a GLM endpoint the SDK sends every
`/v1/messages` call there instead of `api.anthropic.com`. The rest of Alfred
— tool loop, hooks, skills, ledger — is unchanged.

## Environment setup

```bash
# The GLM Anthropic-compatible endpoint
export ALFRED_BASE_URL=https://open.bigmodel.cn/api/anthropic

# Your Zhipu API key (reused in the ANTHROPIC_API_KEY slot)
export ANTHROPIC_API_KEY=<your-zhipu-api-key>
```

::: info Why ANTHROPIC_API_KEY?
The SDK always sends the key in the `x-api-key` header regardless of the base
URL. Zhipu's Anthropic-compatible endpoint reads that same header.
:::

## One-shot query with GLM

```bash
alfred --model glm-5.1 "Summarise the last five commits in this repo."
```

Or set the model globally to avoid repeating the flag:

```bash
export ALFRED_MODEL=glm-5.1
alfred "List all exported functions in src/tools/index.ts"
```

### Available GLM model ids

Alfred's pricing table (`src/cost/tracker.ts`) includes three GLM models:

| Model id | Input (per 1M) | Output (per 1M) | Cache read | Cache write |
|---|---|---|---|---|
| `glm-4.5` | $0.60 | $2.20 | $0.11 | $0.75 |
| `glm-4.6` | $0.60 | $2.20 | $0.11 | $0.75 |
| `glm-5.1` | $0.60 | $2.20 | $0.11 | $0.75 |

These are approximately 5× cheaper than `claude-sonnet-4-6` on input tokens.

## Autonomous run with GLM

```bash
export ALFRED_BASE_URL=https://open.bigmodel.cn/api/anthropic
export ANTHROPIC_API_KEY=<your-zhipu-api-key>
export ALFRED_LEDGER_SECRET=$(openssl rand -hex 32)

alfred run \
  --model glm-5.1 \
  --verify "bun test" \
  --feature-list feature_list.json \
  --budget-usd 1.00
```

The `--budget-usd` flag is especially useful with GLM because the cost
estimator uses the pricing table above — setting a dollar cap prevents
runaway spending on large feature lists.

## Role routing with GLM

Alfred supports per-role model overrides (ADR 0005). You can mix providers
within a single run by assigning different roles to different models:

```bash
# Use GLM for fast editor work; keep the default model for architecture
export ALFRED_MODEL_EDITOR=glm-5.1
export ALFRED_MODEL=claude-sonnet-4-6

alfred run --verify "bun test"
```

Role env variables:

| Variable | Role | Purpose |
|---|---|---|
| `ALFRED_MODEL_ARCHITECT` | `architect` | Planning and high-level reasoning |
| `ALFRED_MODEL_EDITOR` | `editor` | Applying file edits |
| `ALFRED_MODEL_SUBAGENT` | `subagent` | Delegated subtasks |

Roles not set fall back to `ALFRED_MODEL` (or the `--model` flag).

## Alternative: ANTHROPIC_BASE_URL

If you prefer not to set `ALFRED_BASE_URL` you can use the SDK's own env
variable:

```bash
export ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic
```

`ALFRED_BASE_URL` takes precedence when both are set.

## Pointing at any compatible endpoint

The same pattern works for any service that implements the Anthropic Messages
API:

```bash
# Local proxy or self-hosted model
export ALFRED_BASE_URL=http://localhost:8080

# Another cloud provider's Anthropic-compatible gateway
export ALFRED_BASE_URL=https://gateway.example.com/anthropic

alfred --model my-custom-model "Hello"
```

::: tip Model id mismatch
If the endpoint rejects your model id, check the provider's documentation for
the exact string they expect. Alfred passes the value of `--model` (or
`ALFRED_MODEL`) verbatim to the `model` field in the API request.
:::

::: warning Streaming and token counting
Some compatible endpoints do not implement streaming
(`client.messages.stream`) or token counting
(`client.messages.countTokens`). Alfred falls back gracefully — streaming
failure is caught and re-thrown as a `ProviderError`; token counting is
optional and only used for context-window management.
:::
