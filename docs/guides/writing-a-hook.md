# Writing a Hook

Hooks are shell scripts or commands that fire around tool calls. They receive
a JSON payload on stdin and communicate back via exit code and stdout. Use them
to enforce policies, audit tool use, or rewrite tool inputs without touching
Alfred's source code.

## Configuration file

Hooks are defined in `.alfred/hooks.json` in the project root:

```json
{
  "hooks": [
    {
      "event":       "PreToolUse",
      "toolPattern": "bash",
      "command":     "scripts/hooks/block-dangerous-commands.sh",
      "timeoutMs":   5000
    }
  ]
}
```

Alfred loads this file at startup via `loadHooksConfig()`. A missing file is
treated as an empty config (no hooks), not an error.

### Hook matcher fields

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `event` | `"PreToolUse" \| "PostToolUse"` | yes | — | When the hook fires |
| `toolPattern` | string | no | `"*"` | Tool name to match; `"*"` or absent matches all tools |
| `command` | string (non-empty) | yes | — | Shell command run via `sh -c` |
| `timeoutMs` | positive integer | no | `10000` | Milliseconds before the hook process is killed |

`toolPattern` supports exact match only — no glob wildcards beyond the special
value `"*"`.

## Stdin payload

Every hook receives a JSON object on stdin:

```json
{
  "toolName": "bash",
  "input": {
    "command": "rm -rf /tmp/scratch",
    "timeout": 5000
  }
}
```

`toolName` is the tool's registered name (e.g. `bash`, `file_write`, `grep`,
`load_skill`). `input` is the raw, unvalidated object the model supplied.

## Exit code protocol

| Exit code | Meaning | Notes |
|---|---|---|
| `0` | Allow, optionally rewrite input | Stdout may contain `{"updatedInput":{…}}` |
| `2` | Block the tool call (PreToolUse only) | Stderr is shown as the block reason |
| anything else | Allow, lenient | Hook had an internal error; Alfred continues |
| timeout | Allow, lenient | Hook was too slow; Alfred continues |

**PostToolUse exit 2 is silently ignored** — hooks on that event are
observe-only.

## PreToolUse — blocking a tool call

Exit 2 to prevent the tool from running. Write the reason to stderr.

### Example: block `rm -rf` in bash

```bash
#!/usr/bin/env bash
# .alfred/scripts/block-rm-rf.sh
set -euo pipefail

payload=$(cat)                              # read stdin
tool=$(echo "$payload" | jq -r '.toolName')
cmd=$(echo  "$payload" | jq -r '.input.command // ""')

if [[ "$tool" == "bash" && "$cmd" =~ rm[[:space:]]+-[^[:space:]]*r ]]; then
  echo "Refusing recursive rm: $cmd" >&2
  exit 2
fi

exit 0
```

```json
{
  "hooks": [
    {
      "event":       "PreToolUse",
      "toolPattern": "bash",
      "command":     ".alfred/scripts/block-rm-rf.sh",
      "timeoutMs":   3000
    }
  ]
}
```

When Alfred's bash tool would run a recursive `rm`, this hook exits 2. Alfred
surfaces the stderr message to the user and does **not** execute the command.

::: tip No jq?
You can parse the payload in any language. Here is the same hook in Node.js:

```js
#!/usr/bin/env node
// .alfred/scripts/block-rm-rf.mjs
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { toolName, input } = JSON.parse(Buffer.concat(chunks).toString());

if (toolName === "bash" && /rm\s+-[^\s]*r/.test(input.command ?? "")) {
  process.stderr.write(`Refusing recursive rm: ${input.command}\n`);
  process.exit(2);
}
process.exit(0);
```
:::

## PreToolUse — rewriting tool input

Exit 0 and write `{"updatedInput":{…}}` to stdout. Alfred merges the object
into the tool input before calling the tool. Only the keys you include are
changed; other keys are preserved.

### Example: force a read-only flag on `grep`

```bash
#!/usr/bin/env bash
# .alfred/scripts/force-ignore-case.sh

# Rewrite all grep calls to enable case-insensitive matching.
printf '{"updatedInput":{"ignoreCase":true}}\n'
exit 0
```

```json
{
  "hooks": [
    {
      "event":       "PreToolUse",
      "toolPattern": "grep",
      "command":     ".alfred/scripts/force-ignore-case.sh"
    }
  ]
}
```

Every time the model calls `grep`, Alfred injects `ignoreCase: true` before
the tool runs, regardless of what the model passed.

### Example: redirect `file_write` to a staging directory

```bash
#!/usr/bin/env bash
# .alfred/scripts/redirect-writes.sh
set -euo pipefail

payload=$(cat)
path=$(echo "$payload" | jq -r '.input.path // ""')

# Prefix writes that go to src/ with staging/
if [[ "$path" == src/* ]]; then
  new_path="staging/${path}"
  printf '{"updatedInput":{"path":"%s"}}\n' "$new_path"
fi

exit 0
```

When stdout does not contain `{"updatedInput":…}` (or is empty), Alfred uses
the original input unchanged.

## PostToolUse — observation and auditing

PostToolUse hooks run after the tool returns but receive the same stdin payload
(the original call input, not the output). They are useful for logging.

### Example: log every `file_write` call

```bash
#!/usr/bin/env bash
# .alfred/scripts/audit-writes.sh
set -euo pipefail

payload=$(cat)
ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "${ts} file_write: $(echo "$payload" | jq -c '.input')" >> .alfred/write-audit.log

exit 0
```

```json
{
  "hooks": [
    {
      "event":       "PostToolUse",
      "toolPattern": "file_write",
      "command":     ".alfred/scripts/audit-writes.sh"
    }
  ]
}
```

Exit code 2 on a PostToolUse hook is silently ignored — the tool already ran.

## Multiple hooks for the same event

Alfred runs matching hooks sequentially. For PreToolUse:

- The first hook that exits 2 wins and short-circuits the remaining hooks.
- `updatedInput` from passing hooks accumulates (later hook wins on key
  conflicts).

```json
{
  "hooks": [
    {
      "event":       "PreToolUse",
      "toolPattern": "bash",
      "command":     ".alfred/scripts/block-rm-rf.sh"
    },
    {
      "event":       "PreToolUse",
      "toolPattern": "bash",
      "command":     ".alfred/scripts/log-commands.sh"
    }
  ]
}
```

If `block-rm-rf.sh` exits 2, `log-commands.sh` is never called.

## Match all tools

Omit `toolPattern` (or set it to `"*"`) to match every tool:

```json
{
  "hooks": [
    {
      "event":   "PreToolUse",
      "command": ".alfred/scripts/global-audit.sh"
    }
  ]
}
```

## Complete working example — two-hook setup

### `.alfred/hooks.json`

```json
{
  "hooks": [
    {
      "event":       "PreToolUse",
      "toolPattern": "bash",
      "command":     ".alfred/scripts/block-rm-rf.sh",
      "timeoutMs":   3000
    },
    {
      "event":       "PostToolUse",
      "toolPattern": "file_write",
      "command":     ".alfred/scripts/audit-writes.sh"
    }
  ]
}
```

### `.alfred/scripts/block-rm-rf.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

payload=$(cat)
tool=$(echo "$payload" | jq -r '.toolName')
cmd=$(echo  "$payload" | jq -r '.input.command // ""')

if [[ "$tool" == "bash" && "$cmd" =~ rm[[:space:]]+-[^[:space:]]*r ]]; then
  echo "Refusing recursive rm: ${cmd}" >&2
  exit 2
fi

exit 0
```

### `.alfred/scripts/audit-writes.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

payload=$(cat)
ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
path=$(echo "$payload" | jq -r '.input.path // "unknown"')
echo "${ts}  file_write  ${path}" >> .alfred/write-audit.log

exit 0
```

Make both scripts executable:

```bash
chmod +x .alfred/scripts/block-rm-rf.sh .alfred/scripts/audit-writes.sh
```

::: tip Testing hooks in isolation
Pipe a sample payload and check the exit code:

```bash
echo '{"toolName":"bash","input":{"command":"rm -rf /tmp/x"}}' \
  | bash .alfred/scripts/block-rm-rf.sh
echo "exit: $?"
```

Expected: stderr contains the refusal message, exit code is 2.
:::

::: warning Hook failures are lenient
If a hook exits with a code other than 0 or 2, or times out, Alfred logs the
failure and continues as if the hook allowed the call. Hooks must never crash
Alfred. Use this property to make hooks fail-open during development.
:::
