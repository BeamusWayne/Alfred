# alfred [prompt] — one-shot query

`alfred [prompt]` is the default command. It runs the agent once for the given
prompt, streams tool traces to stderr, writes the assistant's text to stdout,
then exits.

```bash
alfred "Add a slugify function to src/strings/slugify.ts"
alfred -p "What does this repo do?" | cat
echo "What does this repo do?" | alfred -p   # print mode reads stdin when piped
```

Bare `alfred` (no prompt) opens a **thin REPL** on a TTY — multi-turn, with
interactive `[y/N/a]` tool approval and `/status` `/cost` `/clear` `/help` —
and prints the **status screen** (provider/key, feature_list, last run, next
steps) everywhere else. `alfred status`, `alfred demo`, `alfred init`,
`alfred doctor` (one-pass setup diagnosis), `alfred update`, `alfred why`,
`alfred watch` and `alfred completion <shell>` round out the surface; the
[README command table](https://github.com/BeamusWayne/Alfred#commands) has the
one-line summary of each.

## Options

| Flag | Alias | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--model <model>` | `-m` | string | `ALFRED_MODEL` or `claude-sonnet-4-6` | Model id forwarded to the provider |
| `--print` | `-p` | boolean | false | Print mode — non-interactive; suppresses any interactive prompts |
| `--permission-mode <mode>` | — | `default` \| `acceptEdits` \| `plan` \| `bypass` | `default` | Approval policy (see [Permissions](/config/permissions)) |
| `--max-turns <n>` | — | integer | `50` | Hard cap on agent turns before the loop halts |
| `--yes` | — | boolean | false | Auto-approve every tool call that would otherwise show an approval prompt |

All flags are optional. When `prompt` is omitted, the built-in help is printed.

## I/O split

Alfred separates concerns across the two standard streams so shell pipelines
work cleanly:

| Stream | Content |
|--------|---------|
| **stdout** | The assistant's text output only — one clean, pipeable answer |
| **stderr** | Tool-use traces, retries, the `[status]` line, and the `[cost: $…]` line |

### stderr lines

During a run you see dim trace lines on stderr:

```
⚙ bash(bun test)           ← tool_use event
  [exit 0] …               ← tool_result (success)
  [exit 1] …               ← tool_result (error, shown in red)
↻ retry 1 in 2000ms (…)    ← retrying event
✗ <message>                ← error event
[success]                  ← done event — the terminal status
[cost: $0.0031]            ← cost line (only when cost > $0)
```

The `[status]` value is one of the `QueryState` statuses produced by the query
engine (e.g. `success`, `max_turns`, `error`).

The `[cost: …]` line is emitted only when the returned cost is non-zero; it
shows four decimal places of USD.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | The agent loop completed with `status === "success"` |
| `1` | Any other terminal status (`max_turns`, `error`, etc.) |

## Environment variables

The one-shot command reads a subset of Alfred's global env vars. See
[Environment Variables](/config/environment) for the full table; the relevant
ones for this command are `ALFRED_PROVIDER`, `ALFRED_MODEL`, `ALFRED_BASE_URL`,
`ALFRED_MEMORY`, `ALFRED_REPOMAP`, `ALFRED_SANDBOX`, `ANTHROPIC_API_KEY`, and
`OPENAI_API_KEY`.

## Examples

```bash
# Basic one-shot
alfred "Explain the purpose of src/orchestrator/ledger.ts"

# Pipe the answer to a file
alfred -p "Generate a CHANGELOG entry for this diff" > CHANGELOG.md

# Use a specific model with auto-approve
alfred -m claude-opus-4-5 --yes "Refactor src/query/engine.ts for readability"

# Read-only planning pass (no mutations allowed)
alfred --permission-mode plan "What changes would add OpenTelemetry tracing?"

# Cap at 10 turns to keep costs bounded
alfred --max-turns 10 "Investigate why tests/ledger.test.ts is failing"
```

::: tip stdout is always clean text
Because tool traces go to stderr, `alfred -p "…" | pbcopy` or
`alfred -p "…" | jq '…'` work without stripping ANSI codes or noise.
:::

::: warning API key required
Alfred warns on stderr and continues if the key for the active provider is
missing. In practice, the first API call will fail; set `ANTHROPIC_API_KEY`
(or `OPENAI_API_KEY` for `ALFRED_PROVIDER=openai`) before running.
:::
