# Hooks

Alfred's hooks engine lets you intercept every tool call with short-lived shell scripts — before execution to inspect or block it, and after execution to observe the result. Hooks are defined in `.alfred/hooks.json` and require no code changes to Alfred itself.

## How the engine invokes hooks

The query engine calls `runHooks` from `src/hooks/engine.ts` at two points inside `executeTool` (in `src/query/engine.ts`):

1. **PreToolUse** — called _before_ the tool runs, after input validation but before permission evaluation begins. A hook that exits 2 here stops the tool entirely; the model receives an error result. A hook that emits `{"updatedInput":{…}}` on stdout causes the engine to re-validate and replace the input before proceeding.
2. **PostToolUse** — called _after_ the tool returns, with the final input that was actually sent to the tool. PostToolUse hooks are observe-only: any exit-2 signal is silently ignored.

Hooks run sequentially for each event. For PreToolUse, the first hook that exits 2 short-circuits the remaining hooks immediately. `updatedInput` rewrites accumulate across hooks (last writer per key wins), and each successive hook receives the updated input, not the original.

## `.alfred/hooks.json` format

```json
{
  "hooks": [
    {
      "event": "PreToolUse",
      "toolPattern": "bash",
      "command": "~/.alfred/scripts/audit-bash.sh",
      "timeoutMs": 5000
    },
    {
      "event": "PostToolUse",
      "toolPattern": "*",
      "command": "logger -t alfred 'tool finished'"
    }
  ]
}
```

A missing file is silently treated as an empty config (no hooks). A malformed file causes Alfred to abort with a descriptive error at startup.

### Field reference

| Field | Type | Required | Description |
|---|---|---|---|
| `event` | `"PreToolUse"` \| `"PostToolUse"` | Yes | Lifecycle point at which the hook fires. |
| `toolPattern` | `string` | No | Tool name filter. `"*"` or omitted matches every tool; any other value is an exact string match against the tool name. |
| `command` | `string` | Yes | Shell command executed via `sh -c`. Receives a JSON payload on stdin. |
| `timeoutMs` | `number` | No | Milliseconds before the hook process is killed. Default: `10000`. A timed-out hook is treated as a lenient allow (Alfred never blocks on a slow hook). |

::: info toolPattern matching
`toolPattern` supports two forms only: `"*"` (or absent) for all tools, or an exact string for one specific tool name. There is no glob wildcard beyond `"*"`. MCP tools are named `mcp__<original-name>`, so `"toolPattern": "mcp__my_server"` targets that server's adapter exactly.
:::

## The exit-2-blocks contract

Each hook process communicates its decision through its exit code and streams:

| Exit code | stdout | Meaning |
|---|---|---|
| `0` | `{"updatedInput":{…}}` | Allow. Replace the tool input with the given object (merged over the current input). |
| `0` | anything else / empty | Allow. Input is unchanged. |
| `2` | _(ignored)_ | **Block** (PreToolUse only). Execution is halted; the model receives an error whose text is the hook's **stderr**. |
| any other non-zero | _(ignored)_ | Lenient allow. Hook had an internal error; Alfred does not fail. |
| killed (timeout) | _(ignored)_ | Lenient allow. Hook was too slow. |

::: warning PostToolUse exit 2 is silently ignored
A PostToolUse hook that exits 2 does _not_ retroactively cancel the tool; the result has already been returned to the model. Use PostToolUse only for observation, logging, or side effects.
:::

### stdin payload

The hook process receives a single JSON object on stdin:

```json
{
  "toolName": "write_file",
  "input": {
    "path": "/project/src/index.ts",
    "content": "…"
  }
}
```

`input` reflects the current (possibly already-rewritten) input at the point this hook is invoked — not necessarily the original input the model sent.

## Worked examples

### Example 1 — blocker: deny writes outside the project root

Save as `.alfred/hooks/guard-writes.sh` and make it executable:

```bash
#!/usr/bin/env bash
# Block write_file calls whose path escapes the working directory.
set -euo pipefail

payload="$(cat)"   # full JSON on stdin
path="$(echo "$payload" | jq -r '.input.path // empty')"

if [[ -z "$path" ]]; then
  exit 0  # no path field — not our concern
fi

# Resolve to an absolute path for reliable comparison
abs="$(realpath -m "$path")"
cwd="$(pwd)"

if [[ "$abs" != "$cwd"/* ]]; then
  echo "Refusing write outside project root: $abs" >&2
  exit 2
fi

exit 0
```

Hook config:

```json
{
  "hooks": [
    {
      "event": "PreToolUse",
      "toolPattern": "write_file",
      "command": ".alfred/hooks/guard-writes.sh",
      "timeoutMs": 3000
    }
  ]
}
```

When the model attempts to write `/etc/passwd`, Alfred returns an error to the model: `Blocked by PreToolUse hook: Refusing write outside project root: /etc/passwd`.

### Example 2 — input rewriter: force read-only mode on bash commands

This hook rewrites every `bash` call to prepend a no-write alias and removes `sudo` from the command string before the tool ever sees it:

```bash
#!/usr/bin/env bash
set -euo pipefail

payload="$(cat)"
cmd="$(echo "$payload" | jq -r '.input.command // empty')"

# Strip sudo invocations (best-effort; real enforcement lives in the tool itself)
sanitised="${cmd//sudo /}"

# Emit the rewrite; Alfred merges this over the existing input
printf '{"updatedInput":{"command":"%s"}}' \
  "$(echo "$sanitised" | jq -Rrs '.')"
exit 0
```

Hook config:

```json
{
  "hooks": [
    {
      "event": "PreToolUse",
      "toolPattern": "bash",
      "command": ".alfred/hooks/sanitise-bash.sh",
      "timeoutMs": 2000
    }
  ]
}
```

The engine re-validates the rewritten input against the tool's Zod schema before passing it to the tool. If the rewrite produces an invalid input, the rewrite is silently dropped and the original validated input is used.

## Type reference

Defined in `src/hooks/types.ts`:

```ts
type HookEvent = "PreToolUse" | "PostToolUse";

interface HookMatcher {
  readonly event: HookEvent;
  readonly toolPattern?: string;   // "*" or omit = all tools; else exact match
  readonly command: string;        // sh -c command
  readonly timeoutMs?: number;     // default 10 000 ms
}

interface HooksConfig {
  readonly hooks: readonly HookMatcher[];
}

interface HookOutcome {
  readonly block: boolean;         // true only from exit-2 PreToolUse
  readonly reason?: string;        // hook's stderr on block
  readonly updatedInput?: Record<string, unknown>;  // merged rewrite
}
```

The `hooksConfigSchema` Zod schema (also in `src/hooks/types.ts`) validates `.alfred/hooks.json` at load time; any schema violation aborts startup with a descriptive message.
