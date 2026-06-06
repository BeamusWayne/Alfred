# Tools

Alfred exposes a typed, capability-declared tool system. Every built-in tool is registered through the `buildTool()` factory and surfaced to the model via the tool registry (`src/tools/index.ts`). The query engine consults the capability flags to decide parallelism, permissions, and security fencing.

---

## Tool Contract

**Source:** `src/tools/types.ts`

Every tool implements the `Tool<In, Out>` interface:

```ts
interface Tool<In extends z.ZodTypeAny = z.ZodTypeAny, Out = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: In;                          // Zod schema — validated before call()

  call(input: z.output<In>, ctx: ToolContext): Promise<ToolResult<Out>>;

  isEnabled(): boolean;
  isReadOnly(input: z.output<In>): boolean;          // true → eligible for parallel execution
  isConcurrencySafe(input: z.output<In>): boolean;   // true → safe to run alongside other tools
  checkPermissions(input, ctx: ToolPermissionContext): Promise<PermissionResult>;

  describeCall(input: z.output<In>): string;         // short label shown in UI, e.g. "bash(ls -la)"
  render(result: ToolResult<Out>): readonly ContentBlock[];
}
```

### `ToolResult`

```ts
interface ToolResult<T = unknown> {
  readonly content: T;
  readonly isError?: boolean;
  /** Marks content from untrusted sources — triggers fence() in the engine (ADR 0003). */
  readonly untrusted?: boolean;
}
```

Setting `untrusted: true` causes the query engine to wrap the serialised content in a taint fence before it enters the model's prompt. See [Security](/subsystems/security) for the full taint + fence explanation.

### `ToolContext`

```ts
interface ToolContext {
  readonly workingDir: string;
  readonly signal: AbortSignal;
  /** Path → last-read snapshot; enables read-before-write + mtime freshness checks. */
  readonly readFileState: Map<string, { content: string; mtimeMs: number }>;
  readonly permissions: ToolPermissionContext;
}
```

`readFileState` is a session-scoped map populated by `file_read` and updated by `file_write`/`file_edit`. It is the mechanism that enforces the read-before-write and mtime freshness invariants.

### `buildTool()` factory

`buildTool(spec)` fills conservative defaults so tool authors only declare what differs:

| Flag | Default | Meaning |
|---|---|---|
| `isEnabled()` | `true` | Tool appears in the registry |
| `isReadOnly()` | `false` | Treated as mutating; runs serially |
| `isConcurrencySafe()` | `false` | Not run in parallel with other tools |
| `checkPermissions()` | `allow()` | Always permitted |
| `describeCall()` | `tool.name` | Falls back to bare name |
| `render()` | text block | Serialises `content` as text |

The engine parallelises a tool call only when **both** `isReadOnly()` and `isConcurrencySafe()` return `true` for the parsed input.

---

## Tool Registry

**Source:** `src/tools/index.ts`

`getAllTools()` returns the built-in set filtered by `isEnabled()`. `findTool(tools, name)` looks up a tool by name. Built-ins in registration order:

```
file_read, file_write, file_edit, bash, glob, grep,
memory_search, memory_upsert, memory_forget, web_fetch, load_skill
```

---

## Built-in Tools Reference

### `file_read`

**Source:** `src/tools/fileRead.ts` | Read-only, concurrency-safe

Read a UTF-8 file and return its contents with line numbers. Records `{content, mtimeMs}` in `readFileState` so subsequent `file_edit` or `file_write` calls can enforce the read-before-write and freshness invariants.

**Input schema:**

| Field | Type | Description |
|---|---|---|
| `path` | `string` | Absolute or workspace-relative file path |
| `offset` | `number` (optional) | 1-based line to start from |
| `limit` | `number` (optional) | Maximum lines to return (default 2000) |

**Behavior:** Output lines are formatted as `{lineNum}\t{lineText}`. When the file is larger than `offset + limit` lines, a truncation note is appended. Returns `isError: true` if the file does not exist. Path is resolved inside the workspace via `resolveInside()`.

---

### `file_write`

**Source:** `src/tools/fileWrite.ts` | Mutating, serial

Create a new file or overwrite an existing one. Updates `readFileState` after writing so the session snapshot stays fresh. Requires approval (`ask`) in `default` permission mode; auto-allows in `acceptEdits` mode.

**Input schema:**

| Field | Type | Description |
|---|---|---|
| `path` | `string` | File path to write |
| `content` | `string` | Full file contents |

**Behavior:** Writes atomically via `Bun.write`. Returns a success message including whether the file was created or overwritten and the byte count. Denies writes outside the workspace root.

---

### `file_edit`

**Source:** `src/tools/fileEdit.ts` | Mutating, serial

Replace a unique snippet in a file. This tool enforces four invariants before any write reaches disk:

#### 1. Read-before-write

The file must have been read this session (`readFileState` must contain an entry for the resolved path). If not, the tool returns an error instructing the model to read first.

#### 2. Mtime freshness

The on-disk `mtimeMs` is compared to the snapshot recorded by `file_read`. If they differ, an external change has occurred and the edit is rejected with a message to re-read the file.

#### 3. Fuzzy match ladder (`seekSequence`)

**Source:** `src/tools/lib/seekSequence.ts`

`old_string` is located by content, not by line number, using a four-rung ladder of increasingly forgiving comparators. The engine stops at the first rung that finds exactly one match:

| Strategy | Normalisation applied |
|---|---|
| `exact` | No normalisation — plain `indexOf` |
| `rstrip` | Trailing whitespace stripped from each line |
| `trim` | Leading and trailing whitespace stripped from each line |
| `collapse` | Trim + internal whitespace collapsed to single space |

If all four rungs fail to find a match, the edit is rejected. If any rung finds more than one match and `replace_all` is not set, the edit is rejected with an ambiguity error — the model must provide more surrounding context.

The success message reports which strategy was used when it was not `exact`, e.g. `Edited src/foo.ts — 1 replacement (matched via trim).`

#### 4. Post-edit syntax check

**Source:** `src/tools/lib/syntaxCheck.ts`

After constructing the edited file content in memory, `checkSyntax(path, next)` is called **before** any write. If the result would be syntactically broken, the edit is rejected and the file is left unchanged. See [Code Intelligence](/subsystems/code-intelligence) for the full syntax check description.

**Input schema:**

| Field | Type | Description |
|---|---|---|
| `path` | `string` | File to edit |
| `old_string` | `string` | Existing text to replace |
| `new_string` | `string` | Replacement text |
| `replace_all` | `boolean` (optional) | Replace every exact occurrence |

---

### `bash`

**Source:** `src/tools/bash.ts` | Conditionally read-only, serial

Execute a shell command and return combined stdout + stderr and the exit code.

**Input schema:**

| Field | Type | Description |
|---|---|---|
| `command` | `string` | Shell command |
| `timeout` | `number` (optional) | Timeout in ms (default 120,000) |
| `cwd` | `string` (optional) | Working directory within the workspace |

**Read-only detection:** `isReadOnly()` returns `true` when every chained segment (split on `&&`, `\|\|`, `;`, `\|`, `&`) uses only known-safe commands. The read-only allowlist includes: `ls`, `cat`, `head`, `tail`, `wc`, `echo`, `pwd`, `find`, `grep`, `rg`, `tree`, `stat`, `diff`, `sort`, `uniq`, `cut`, `awk`, `sed`, and others. For `git`, only the subcommands `status`, `log`, `diff`, `branch`, `show`, `remote`, `rev-parse` are considered read-only.

**Kill-list:** `checkPermissions()` returns `deny()` for commands matching any of the following patterns, regardless of permission mode (even `bypass`):

- `rm` with `-r` or `-f` flags targeting `/`, `~`, `$HOME`, or `/*`
- `mkfs`
- `dd` writing to `/dev/`
- Fork bombs (`:() { : | :& };`)
- `shutdown`, `reboot`, `halt`, `poweroff`
- Redirects to `/dev/sd*`, `/dev/nvme*`, `/dev/disk*`
- `chmod -R 0777 /`

::: warning Security note
String matching is a UX convenience, not a security boundary. The real boundary is the OS sandbox (`ALFRED_SANDBOX=1`), which wraps commands in `sandbox-exec` on macOS and denies network access plus writes outside the workspace. Until the sandbox is enabled, `bash` asks for approval by default.
:::

**Output:** Stdout and stderr are combined. Output is truncated to 30,000 characters. Non-zero exit codes produce `isError: true` with the exit code prepended.

**Abort:** The process is killed with `SIGTERM` when the `AbortSignal` fires.

---

### `glob`

**Source:** `src/tools/glob.ts` | Read-only, concurrency-safe

List files matching a glob pattern using Bun's native `Bun.Glob`.

**Input schema:**

| Field | Type | Description |
|---|---|---|
| `pattern` | `string` | Glob pattern, e.g. `src/**/*.ts` |
| `path` | `string` (optional) | Directory to search from (default: workspace root) |

**Behavior:** Results are workspace-relative, sorted alphabetically, capped at 500 entries. Automatically skips `node_modules/`, `.git/`, and `dist/`. Hidden files (`dot: false`) are excluded.

---

### `grep`

**Source:** `src/tools/grep.ts` | Read-only, concurrency-safe

Search file contents with a regular expression. Pure JavaScript implementation — no ripgrep dependency, fully hermetic in tests.

**Input schema:**

| Field | Type | Description |
|---|---|---|
| `pattern` | `string` | Regular expression |
| `path` | `string` (optional) | Directory or file to search (default: workspace root) |
| `glob` | `string` (optional) | Only search files matching this glob (default `**/*`) |
| `ignoreCase` | `boolean` (optional) | Case-insensitive match |

**Behavior:** Returns matches as `file:line:text` lines (line text truncated to 300 chars), capped at 200 matches. Files larger than 1 MB are skipped. Binary files (containing a NUL byte) are skipped. Automatically skips `node_modules/`, `.git/`, and `dist/`.

---

### `web_fetch`

**Source:** `src/tools/webFetch.ts` | Not read-only, serial

Fetch a URL over HTTP/HTTPS. All three lethal-trifecta mitigations apply — see [Security](/subsystems/security) and the dedicated `web_fetch` section there. Key points:

- Default-deny egress; host must be in `ALFRED_EGRESS_ALLOW`.
- `untrusted: true` is always set on a successful response — the engine fences the content.
- `redact()` is applied to the body before return.
- Body capped at `maxBytes` characters (default 100,000).
- `checkPermissions` returns `ask()` for any host on the allow-list — the user sees every outbound fetch even in `acceptEdits` mode.

**Input schema:**

| Field | Type | Description |
|---|---|---|
| `url` | `string` | URL to fetch (http or https only) |
| `maxBytes` | `number` (optional) | Body character cap (default 100,000) |

---

### `memory_search`

**Source:** `src/tools/memoryTool.ts` | Read-only, concurrency-safe

Full-text search over the workspace-local memory store (`<workingDir>/.alfred/memory`). Returns matching facts with type, slug, content, and timestamps.

**Input schema:**

| Field | Type | Description |
|---|---|---|
| `query` | `string` | Full-text search query |
| `k` | `number` (optional) | Max results (1–50, default 10) |

---

### `memory_upsert`

**Source:** `src/tools/memoryTool.ts` | Mutating, serial

Insert or update a memory fact. Upserting an existing slug overwrites the previous value (update-don't-duplicate policy).

**Input schema:**

| Field | Type | Description |
|---|---|---|
| `slug` | `string` | Lowercase alphanumeric + hyphens identifier |
| `type` | `"user" \| "feedback" \| "project" \| "reference"` | Fact category |
| `content` | `string` | Fact body (markdown OK) |
| `scope` | `string` (optional) | Workspace-relative file/dir this fact applies to |
| `ttl` | `string` (optional) | ISO-8601 expiry date, e.g. `2026-12-31` |

---

### `memory_forget`

**Source:** `src/tools/memoryTool.ts` | Mutating, serial

Permanently delete a memory fact by slug. No-op if the slug does not exist.

**Input schema:**

| Field | Type | Description |
|---|---|---|
| `slug` | `string` | Slug of the fact to delete |

---

### `load_skill`

**Source:** `src/skills/skillTool.ts` | Read-only, concurrency-safe

Level-2 on-demand skill body loader. The model holds only the Level-1 index (name + description) in context. When it needs the full procedural instructions for a skill it calls `load_skill` with the skill name. The tool reads and returns the `SKILL.md` body from `<workingDir>/.alfred/skills/<name>/`. This progressive-disclosure design avoids pre-loading skill bodies the model may never need.

**Input schema:**

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Skill name (must match a subdirectory in the skills dir) |

Returns `isError: true` with a helpful message if the skill name is not found.
