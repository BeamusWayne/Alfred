# Hooks

Alfred's hooks engine lets you intercept the session lifecycle and every tool call with short-lived shell scripts — before execution to inspect or block, after execution to observe. Hooks are defined in `.alfred/hooks.json` and require no code changes to Alfred itself.

Since 0.7, payloads are **Claude Code-compatible** (same snake_case field names, same event taxonomy), so recorders and policy hooks written for that ecosystem run against Alfred unchanged — [NightWatch](https://github.com/BeamusWayne/NightWatch) records an Alfred session with one `nightwatch init --agent alfred`.

## The six events

Tool events fire from `executeTool` in the query engine; lifecycle events fire from the CLI surfaces (one-shot, REPL, and — crucially — unattended `alfred run`):

1. **SessionStart** — a session began. `source` says which surface: `startup` (one-shot), `repl`, or `run` (autonomous harness).
2. **UserPromptSubmit** — a prompt was submitted (in `alfred run`, a synthesized line describing the run's goal and verify gate). **Exit 2 blocks the prompt**; stderr becomes the reason shown to the user.
3. **PreToolUse** — _before_ a tool runs, after input validation. Exit 2 blocks the call; `{"updatedInput":{…}}` on stdout rewrites the input (re-validated before use).
4. **PostToolUse** — _after_ a tool returns, with the final input **and the output exactly as the model will see it** (`tool_response`). Observe-only.
5. **Stop** — the agent finished responding (one response cycle complete). Observe-only.
6. **SessionEnd** — the session ended. `source` carries the exit reason. Observe-only.

Hooks run sequentially for each event. On blocking events the first hook that exits 2 short-circuits the rest. `updatedInput` rewrites accumulate across hooks (last writer per key wins), and each successive hook receives the updated input, not the original.

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
| `event` | `"SessionStart"` \| `"UserPromptSubmit"` \| `"PreToolUse"` \| `"PostToolUse"` \| `"Stop"` \| `"SessionEnd"` | Yes | Lifecycle point at which the hook fires. |
| `toolPattern` | `string` | No | Tool name filter (tool events). `"*"` or omitted matches every tool; any other value is an exact string match. On lifecycle events an exact pattern never matches — use `"*"` or omit. |
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
| `2` | _(ignored)_ | **Block** (PreToolUse and UserPromptSubmit only). Execution is halted; the error text is the hook's **stderr**. On all other events exit 2 is observe-only. |
| any other non-zero | _(ignored)_ | Lenient allow. Hook had an internal error; Alfred does not fail. |
| killed (timeout) | _(ignored)_ | Lenient allow. Hook was too slow. |

::: warning PostToolUse exit 2 is silently ignored
A PostToolUse hook that exits 2 does _not_ retroactively cancel the tool; the result has already been returned to the model. Use PostToolUse only for observation, logging, or side effects.
:::

### stdin payload

The hook process receives a single JSON object on stdin, in a **Claude Code-compatible shape** (snake_case) with Alfred's pre-0.7 keys kept alongside:

```json
{
  "session_id": "alfred-run-2026-06-12T17-04-51-668Z",
  "cwd": "/project",
  "hook_event_name": "PostToolUse",
  "model": "claude-fable-5",
  "tool_name": "file_write",
  "tool_input": { "path": "src/index.ts", "content": "…" },
  "tool_response": "wrote 412 bytes",
  "toolName": "file_write",
  "input": { "path": "src/index.ts", "content": "…" }
}
```

- `session_id` is stable across one CLI session (`alfred-<uuid>`) or one autonomous run (`alfred-run-<runId>`); sub-agents inherit it, so a recorder stitches the whole run into one ledger.
- `tool_response` (PostToolUse only) is the output exactly as the model will see it — fenced/quarantined if security processing applied.
- `prompt` appears on UserPromptSubmit; `source` on SessionStart/SessionEnd.
- `tool_input`/`input` reflect the current (possibly already-rewritten) input at the point this hook is invoked — not necessarily the original input the model sent.

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

## Example 3 — flight recorder: record the whole session with NightWatch

The flagship integration. [NightWatch](https://github.com/BeamusWayne/NightWatch) is a black-box recorder built on exactly this payload contract:

```bash
npm i -g nightwatch-agent
nightwatch init --agent alfred        # writes five entries into .alfred/hooks.json (idempotent)
alfred run --verify "bun test"        # every event lands in an external hash-chained ledger
nightwatch debrief                    # morning report: claims re-verified against ground truth
```

The run now has two independent witnesses — Alfred's own HMAC-signed ledger and NightWatch's external record. See [the Agent Trust Layer](https://github.com/BeamusWayne/agent-trust-layer) for the dual-witness walkthrough with real committed artifacts.

## Type reference

Defined in `src/hooks/types.ts`:

```ts
type HookEvent =
  | "SessionStart" | "UserPromptSubmit"
  | "PreToolUse" | "PostToolUse"
  | "Stop" | "SessionEnd";

const BLOCKING_EVENTS: ReadonlySet<HookEvent>; // PreToolUse, UserPromptSubmit

interface HookContext {
  readonly sessionId: string;      // threaded into every payload as session_id
  readonly cwd: string;
  readonly model?: string;
}

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
  readonly block: boolean;         // true only from exit-2 on a blocking event
  readonly reason?: string;        // hook's stderr on block
  readonly updatedInput?: Record<string, unknown>;  // merged rewrite
}
```

The `hooksConfigSchema` Zod schema (also in `src/hooks/types.ts`) validates `.alfred/hooks.json` at load time; any schema violation aborts startup with a descriptive message. Payload construction lives in `src/hooks/payload.ts`; lifecycle firing in `src/hooks/lifecycle.ts`.
