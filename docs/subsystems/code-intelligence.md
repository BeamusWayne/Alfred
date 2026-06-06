# Code Intelligence

Alfred adds structural and semantic code awareness in three layers, defined in [ADR 0002](/adr/0002-code-intelligence): a **repo map** for whole-repo structural context, a **post-edit syntax check** to prevent broken code from reaching disk, and an **LSP client** for IDE-grade go-to-definition, find-references, hover, and diagnostics.

::: info Bootstrap status
All three libraries are fully built and unit-tested. The **LSP client is wired into startup**: `bootstrapExtensions()` connects every server declared in `.alfred/lsp.json` before the first model turn and exposes `lsp_definition` / `lsp_references` / `lsp_hover` (see [Configuration](#configuration-alfred-lsp-json)). The repo map remains an opt-in library pending its own startup wiring.
:::

---

## Repo Map

**Sources:** `src/context/repomap.ts`, `src/context/lib/symbols.ts`, `src/context/lib/pagerank.ts`

The repo map produces a compact, token-budgeted listing of the most structurally important source files and their exported symbols, suitable for injection into the system prompt alongside memory core context.

### Algorithm

`buildRepoMap(rootDir, opts)` runs five steps:

**1. Walk the repo**

A recursive directory walk collects all JS/TS source files (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`) up to a cap of 2,000 files. Hidden files and directories starting with `.` are skipped, as are these well-known non-source directories: `node_modules`, `.git`, `.alfred`, `dist`, `build`, `out`, `.next`, `.nuxt`, `coverage`, `.turbo`, `.cache`.

**2. Extract symbols per file**

`extractSymbols(source, lang)` returns a `SymbolMap`:

```ts
interface SymbolMap {
  readonly defs: readonly string[];  // names exported/defined at module scope
  readonly refs: readonly string[];  // identifiers used but not defined here
}
```

**Definitions** are extracted by matching module-scope `export function`, `export class`, `export const/let/var/interface/type/enum`, `export default function/class`, top-level `function`, and top-level `class` declarations using regex patterns anchored to line starts.

**References** are all non-keyword, non-def identifier tokens remaining after stripping line comments, block comments, and string/template literals.

The `lang` parameter (`"ts"` or `"js"`) is the documented seam for a future tree-sitter upgrade — v1 uses the same regex for both languages.

**3. Build a file-to-file reference graph**

An edge is drawn from file A to file B whenever A contains a reference token that matches one of B's definition names. Edge weights incorporate two factors:

- **Ubiquity penalty:** weight is divided by `sqrt(number of files defining the symbol)` — symbols defined everywhere (e.g. `true`, common utilities) contribute less signal.
- **Focus boost:** if either the source or target file is in `focusFiles` (the files the model is currently working on), the edge weight is multiplied by 2–3×.

**4. PageRank the graph**

`pageRank(nodes, edges, opts)` runs the standard iterative PageRank formulation:

```
PR(u) = (1 - d) + d × Σ_v [ w(v→u) / out_weight(v) × PR(v) ]
```

Defaults: damping factor `d = 0.85`, max 100 iterations, convergence tolerance `1e-6`. Dangling nodes (files with no outbound references) distribute their rank evenly across all nodes. The function is pure, deterministic, and zero-dependency.

**5. Render within a token budget**

Files are sorted by PageRank score descending. The renderer emits each file's relative path followed by its definition names on an indented line, stopping before the cumulative character count exceeds `tokenBudget × 4` (chars/token estimate, default budget: 1024 tokens / 4096 chars).

Example output injected into the system prompt:

```
## Repo map

src/query/engine.ts
  runQuery
src/tools/types.ts
  buildTool, ToolResult, ToolContext, Tool
src/security/taint.ts
  fence, isTainted, TaintSource
```

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `tokenBudget` | `number` | `1024` | Approximate token budget for the map |
| `focusFiles` | `readonly string[]` | `[]` | Files whose symbols receive a ranking boost |

---

## Post-Edit Syntax Check

**Source:** `src/tools/lib/syntaxCheck.ts`

`checkSyntax(path, content)` is called by `file_edit` after constructing the new file content in memory and **before** any write to disk. If parsing fails, the edit is rejected and the file is left unchanged.

```ts
type SyntaxCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };
```

### Dispatch by extension

| Extension(s) | Parser used |
|---|---|
| `.ts`, `.mts`, `.cts` | `new Bun.Transpiler({ loader: "ts" }).transformSync(content)` |
| `.tsx` | `new Bun.Transpiler({ loader: "tsx" }).transformSync(content)` |
| `.js`, `.mjs`, `.cjs` | `new Bun.Transpiler({ loader: "js" }).transformSync(content)` |
| `.jsx` | `new Bun.Transpiler({ loader: "jsx" }).transformSync(content)` |
| `.json` | `JSON.parse(content)` |
| Any other / no extension | `{ ok: true }` — pass through conservatively |

Empty content always returns `{ ok: true }` — an empty file is valid for every known language.

`isCheckable(path)` returns `true` when `checkSyntax` will actually validate (as opposed to pass through), useful for callers that want to gate on checkability.

The comment `// add tree-sitter grammars here for other languages` marks the extension point for adding support for Python, Go, Rust, and other languages via tree-sitter grammars.

---

## LSP Client

**Sources:** `src/tools/lsp/protocol.ts`, `src/tools/lsp/client.ts`, `src/tools/lsp/tools.ts`

The LSP client speaks JSON-RPC 2.0 over a `LspTransport` abstraction, providing IDE-grade code navigation without recursive grep.

### Transport and framing

**`LspTransport` interface** (`src/tools/lsp/protocol.ts`):

```ts
interface LspTransport {
  send(json: string): void;
  onMessage(cb: (json: string) => void): void;
  close(): void;
}
```

The transport delivers one complete JSON payload per `onMessage` callback. The production `stdioTransport(command, args)` factory spawns a language server process with `Bun.spawn` and pumps stdout through a stateful `createFrameParser` — a streaming parser that reassembles LSP `Content-Length`-framed messages across arbitrary chunk boundaries. Unit tests supply in-memory fake transports and never need a live language server.

Two robustness properties matter for real servers:

- **Byte-accurate framing.** `Content-Length` is a UTF-8 *byte* count. The parser buffers raw bytes and decodes only complete frame bodies, so a multi-byte character (a non-ASCII identifier, an emoji in a string) split across two OS-pipe reads never desynchronises the stream. The transport feeds the parser raw `Uint8Array` chunks; the parser also accepts strings for test convenience.
- **Spawn errors surface.** A missing binary makes `Bun.spawn` throw synchronously; `stdioTransport` rethrows it as `failed to spawn LSP server "<command>": <reason>` so the bootstrap layer can report exactly which server failed.

**`encodeMessage(obj)`** serialises any object to LSP wire format: `Content-Length: N\r\n\r\n<json>`.

### `LspClient`

`LspClient` manages the LSP lifecycle and correlates requests to responses using auto-incrementing integer IDs, mirroring the pattern used by `McpClient`.

**Construction:** `new LspClient(transport, { requestTimeoutMs })`. When `requestTimeoutMs` is set, any request without a response in that window rejects with a clear timeout error instead of hanging forever — a dead or non-conforming server can otherwise stall the whole agent. `bootstrapExtensions` passes its `connectTimeoutMs` (default 15 s) here. Unit-test fakes omit it (their responses are synchronous).

**Lifecycle methods:**

```ts
client.initialize(rootUri)        // sends initialize + initialized; must be called first
client.didOpen(uri, languageId, text)  // notify server that a file is open
client.shutdown()                 // sends shutdown + exit, closes transport
```

**Query methods (all read-only):**

```ts
// Resolve declaration location(s) for the symbol at pos
client.definition(uri, pos): Promise<readonly Location[]>

// Find all references to the symbol at pos
client.references(uri, pos): Promise<readonly Location[]>

// Retrieve hover text (type signature, doc comment) or null
client.hover(uri, pos): Promise<string | null>

// Return cached diagnostics for uri (from publishDiagnostics notifications)
client.diagnostics(uri): readonly Diagnostic[]
```

`diagnostics()` is synchronous — it returns the latest list captured from server-pushed `textDocument/publishDiagnostics` notifications, which the client caches keyed by file URI.

**Position type:** `{ line: number; character: number }` — both fields are 0-based, matching the LSP specification.

### Agent tools

`makeLspTools(client)` builds three `Tool` objects that wrap the client and plug directly into the query engine's tool registry:

| Tool name | `isReadOnly` | `isConcurrencySafe` | Description |
|---|---|---|---|
| `lsp_definition` | `true` | `true` | Go-to-definition — returns `file:line:char` |
| `lsp_references` | `true` | `true` | Find all references — newline-separated list |
| `lsp_hover` | `true` | `true` | Hover info (type, doc comment) |

All three accept `{ path, line, character }` where `path` is absolute and `line`/`character` are 0-based. The tools convert path → `file://` URI before forwarding to the client, and convert response URIs back to absolute paths for display. They return `(no results)` or `(no hover info)` rather than errors when the server has nothing to say.

**Open-on-demand.** Servers like `typescript-language-server` answer queries only for documents that have been `textDocument/didOpen`-ed. The tools therefore read the file from disk and send `didOpen` (with a languageId inferred from the extension) the first time a URI is queried, remembering it so repeat queries don't re-open. The first open of a session waits briefly so the server can index the project before the request races ahead. This is why a freshly bootstrapped `lsp_hover` returns real type information rather than an empty result.

## Configuration: `.alfred/lsp.json` {#configuration-alfred-lsp-json}

Declare one entry per language server. Alfred validates the file and connects each server at startup; a failure is non-fatal but printed as a `[ext] …` warning.

```json
{
  "servers": [
    {
      "command": "node_modules/.bin/typescript-language-server",
      "args": ["--stdio"]
    }
  ]
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `command` | `string` | yes | Server executable. Must be on `$PATH` or an absolute/relative path that resolves. |
| `args` | `string[]` | no | Arguments after `command` (e.g. `["--stdio"]`). |
| `rootUri` | `string` | no | Project root URI. Defaults to `file://<workingDir>`. |

::: tip Use a real binary, not `bunx -y` / `npx -y`
Install the server (`bun add -d typescript typescript-language-server`, or globally) and point `command` at the resolved binary. A first-run `bunx -y …` can emit resolution output and cold-start latency on the stdio channel the handshake needs, which may trip the connect timeout. The verified-working setup above drives a real `typescript-language-server` through `bootstrapExtensions` and returns live hover/definition data. For diagnosing a server that won't connect, see [MCP → Troubleshooting](/extensibility/mcp#troubleshooting) — the launch path and warnings are shared.
:::
