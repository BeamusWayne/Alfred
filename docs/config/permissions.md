# Permissions

Alfred's permission system has **two orthogonal axes** that operate
independently:

1. **Approval policy** — when does Alfred ask before running a tool?
2. **OS sandbox** — what can the process physically do on disk and network?

Combining them lets you tune the UX (fewer prompts) without removing OS-level
enforcement.

## The four permission modes

Set with `--permission-mode <mode>` or via the `ALFRED_PROVIDER` / config
layering. The default is `default`.

| Mode | Alias | Mutating calls | Read-only calls |
|------|-------|---------------|-----------------|
| `default` | — | Ask before each | Auto-allow |
| `acceptEdits` | — | Auto-allow edits inside the workspace; ask for others | Auto-allow |
| `plan` | — | **Deny** — any mutation is refused | Auto-allow |
| `bypass` | — | Auto-allow (skip prompts) | Auto-allow |

```bash
# Interactive session — ask before every write/exec
alfred --permission-mode default "…"

# Autonomous CI — no prompts (used internally by `alfred run`)
alfred --permission-mode bypass "…"

# Read-only exploration — mutations blocked entirely
alfred --permission-mode plan "What would need to change to add OpenTelemetry?"
```

::: warning `bypass` does not disable the kill-list
Even in `bypass` mode, the bash kill-list still **hard-denies** dangerous
commands. See [Kill-list](#kill-list) below.
:::

## Evaluator precedence

The evaluator in `src/permissions/evaluate.ts` applies rules in a strict
priority order. A higher-priority rule **always wins**, even over `bypass`:

```
1. Whole-tool denylist          → DENY  (beats bypass)
2. Tool's own check (kill-list) → DENY  (beats bypass)
3. Read-only detection          → ALLOW
4. plan mode + mutating call    → DENY
5. allowedTools set / bypass    → ALLOW
6. acceptEdits + tool in scope  → ALLOW (handled by tool's own check)
7. Otherwise                    → tool's own decision (allow | ask)
```

This means:

- You can disable prompts (`bypass`), but you **cannot** disable
  `rm -rf /` protection.
- You can make a run read-only (`plan`), but you cannot make it mutate without
  changing the mode.

## Read-only detection

Alfred automatically classifies bash commands as read-only. A command is
read-only if **every pipe/chain segment** starts with one of the following
commands (basename match, leading `VAR=value` assignments stripped):

**Read-only commands:** `ls`, `cat`, `head`, `tail`, `wc`, `echo`, `pwd`,
`which`, `type`, `find`, `grep`, `rg`, `tree`, `stat`, `file`, `date`,
`whoami`, `env`, `printenv`, `basename`, `dirname`, `realpath`, `diff`,
`sort`, `uniq`, `cut`, `awk`, `sed`

**Read-only git subcommands:** `status`, `log`, `diff`, `branch`, `show`,
`remote`, `rev-parse`

Read-only commands auto-run in `default` mode without asking.

## Kill-list

The bash tool maintains a hard-coded denylist of dangerous command patterns.
These patterns are checked on every bash call and **always** return DENY,
regardless of permission mode — even `bypass` cannot override them.

Current kill-list patterns:

| Pattern | Blocked command |
|---------|----------------|
| `rm` with `-r` or `-f` flags targeting `/`, `~`, `$HOME`, or `/*` | `rm -rf /`, `rm -rf ~`, etc. |
| `mkfs` | Filesystem format |
| `dd … of=/dev/…` | Raw device write |
| `: () { :|:& }; :` | Fork bomb |
| `shutdown`, `reboot`, `halt`, `poweroff` | System power commands |
| `> /dev/sd*` or `> /dev/nvme*` or `> /dev/disk*` | Raw disk write |
| `chmod -R 0777 /` | World-write the root filesystem |

::: info String matching is UX, not a security boundary
The kill-list is a best-effort safety net for accidental commands. It uses
naive string matching that does not parse shell quoting. For a hard security
boundary, enable the OS sandbox (`ALFRED_SANDBOX=1`).
:::

## Path jail

The `bash` tool's `cwd` parameter is validated to be **inside the working
directory** before execution. A path that escapes the workspace (via `..` or
absolute paths outside the root) is rejected.

This applies in all permission modes.

## OS sandbox (`ALFRED_SANDBOX`)

Set `ALFRED_SANDBOX=1` to wrap every `bash` call with the operating system's
sandbox mechanism.

| Platform | Mechanism | Behavior |
|----------|-----------|----------|
| macOS (darwin) | `sandbox-exec` with a Seatbelt profile | Denies network; allows reads everywhere; restricts writes to `<workingDir>` and `/tmp` |
| Linux / other | Transparent passthrough (no-op) | No sandbox applied; a `bwrap`/Landlock backend is planned |

### macOS Seatbelt policy

The generated Seatbelt profile (in `src/sandbox/seatbelt.ts`):

```scheme
(version 1)
(deny default)
(allow process*)
(allow file-read*)
(allow file-write* (subpath "<workingDir>"))
(allow file-write* (subpath "/tmp"))
(deny network*)
```

- All operations denied by default.
- Process operations (fork, exec, signal) always allowed.
- All file reads allowed (no restriction).
- File writes restricted to the workspace and `/tmp`.
- Network access denied (outbound fetch blocked at OS level).

```bash
# Enable the sandbox
export ALFRED_SANDBOX=1
alfred run
```

::: tip Two axes, one decision matrix

| | Sandbox off | Sandbox on |
|---|---|---|
| `default` mode | Ask before mutating; kill-list active | Ask before mutating; OS enforces writes + network |
| `bypass` mode | No prompts; kill-list still active | No prompts; OS enforces writes + network |
| `plan` mode | Mutating calls denied by policy | Mutating calls denied by policy AND OS enforces |
| `acceptEdits` mode | Workspace edits auto-allowed; others ask | Same + OS enforces write scope |

:::

::: warning Sandbox is macOS-only in v1
On Linux, `ALFRED_SANDBOX=1` is silently ignored (passthrough). A
`bwrap`/Landlock backend for Linux is planned for a later release.
:::
