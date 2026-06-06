# Contributing

Alfred is built with **TypeScript on Bun**. This page covers the development workflow, house style, and how to add new subsystems.

---

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.3.0
- An `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) if you need live provider calls; most development uses the `MockProvider`.

```bash
bun install
```

Runtime dependencies are intentionally minimal: `@anthropic-ai/sdk`, `commander`, `zod`. All three are listed in `package.json`.

---

## Core commands

```bash
# Run the full test suite (538 tests)
bun test

# Type-check (zero errors required)
bun run typecheck       # → tsc --noEmit

# Start the CLI in dev mode
bun run src/index.ts -p "hello"

# Run an autonomous harness session
ALFRED_LEDGER_SECRET=$(openssl rand -hex 32) \
  bun run src/index.ts run --verify "bun test" --max-features 3

# Replay eval cases (CI regression gate)
bun run src/index.ts eval ./tests/eval-cases.ts
```

---

## Test coverage goal: 80 %

The project targets 80 % line coverage across all modules. Tests live in `tests/` and are co-located by subsystem. Bun's built-in test runner (`bun test`) is the only test framework used — no Jest, no Vitest.

The test suite currently passes at 538 tests with `tsc --noEmit` clean.

**Mandatory TDD flow:**

1. Write the test first — it must fail (RED).
2. Write the minimal implementation — it must pass (GREEN).
3. Refactor; verify coverage stays at or above 80 %.

Use the `MockProvider` (`src/providers/mock.ts`) to script deterministic model responses for unit and integration tests. The `MockProvider` is what `alfred eval` replays: record a trajectory of tool calls and model turns, then assert regressions in CI.

---

## House style

### Strict immutability (CRITICAL)

Never mutate an existing object. Always return a new copy with the change:

```ts
// Wrong
config.model = "new-model";

// Correct
const updated = { ...config, model: "new-model" };
```

This applies to arrays, maps, and every other shared data structure.

### No `any`

The codebase is strict TypeScript. `any` is not allowed. Prefer `unknown` and narrow explicitly, or use a Zod schema at the boundary.

### Zod at all boundaries

Every value crossing a trust boundary (CLI flags, provider responses, tool arguments, file content, MCP output) must be validated with a Zod schema before use. See `src/tools/types.ts` and `src/memory/types.ts` for the established patterns.

### Explicit export types

All public exports must be typed explicitly — no inferred return types on exported functions. This keeps the API surface stable and readable without IDE assistance.

### No `console.log`

Use the OTel telemetry layer (`src/telemetry/otel.ts`) or the structured logger for output. `console.log` is banned; stderr is reserved for OTel/traces (`ALFRED_OTEL_FILE`).

### Small, focused files

Target 200–400 lines per file; 800 is the hard limit. If a file grows beyond that, extract a sub-module. Organize by feature/domain (e.g. `src/memory/`, `src/security/`), not by type (no `src/utils/` catch-all).

### No deep nesting

No more than 4 levels of nesting. Use early returns and helper functions to flatten control flow.

---

## Codebase map

```text
src/
  orchestrator/      Workflow runtime: agent()/parallel()/pipeline(), journal, budget, ledger
    workflows/       Built-in workflows: autonomousRun.ts, bestOfN.ts
  harness/           Autonomous harness: featureList, verify gate, checkpoint, episodes
  query/             Agent loop: engine, retry, types
  memory/            Memory v2: localFile provider, types, episodes
  providers/         LLM adapters: anthropic, openai, mock
  tools/             Model-facing tools: file_read/write/edit, bash, glob, grep, web_fetch, memoryTool, skillTool
    lsp/             LSP client tools: definition, references, hover, diagnostics
    lib/             Edit utilities: seekSequence, syntaxCheck, paths
  permissions/       Tiered approval policy
  sandbox/           macOS seatbelt (ALFRED_SANDBOX=1)
  security/          Taint, egress allow-list, redact, quarantine
  context/           System-prompt assembly, CLAUDE.md/AGENTS.md discovery, repo map
    lib/             PageRank, symbol extraction
  compact/           Context-editing compaction (evict stale tool results)
  telemetry/         OTel GenAI spans
  cost/              Token/USD cost tracker
  eval/              Eval harness: engine, evaluate, types
  config/            Role-based model map (roles.ts), config manager
  hooks/             PreToolUse/PostToolUse hook dispatcher
  mcp/               MCP client: client, toolAdapter, types
  skills/            3-level skill loader: loader, skillTool, types
```

---

## How the codebase was built

Alfred was built via parallel module construction followed by integration: each subsystem (`memory/`, `orchestrator/`, `security/`, `telemetry/`, etc.) was developed and tested in isolation, then wired into the engine and registry in integration passes. This pattern means:

- Each module has its own test file(s) in `tests/`.
- Integration is explicit: no magic auto-discovery. A new subsystem must be wired into `src/index.ts` (CLI commands), `src/query/engine.ts` (loop hooks), or `src/orchestrator/runtime.ts` (workflow primitives) by hand.
- The `MockProvider` is the integration glue for tests — it lets any subsystem be tested without a live API key.

---

## Extension seams

Three stable seams exist for adding new capabilities without touching core logic:

### `buildTool` — adding a new tool

All model-facing tools are registered through the `buildTool()` factory (`src/tools/index.ts`), which attaches capability flags, permission requirements, and the Zod input schema. To add a new tool:

1. Create `src/tools/<name>.ts` implementing the `Tool` interface.
2. Add the Zod input schema and a `PermissionRequirement`.
3. Export from `src/tools/index.ts` and register in the tool registry.
4. Write tests in `tests/tools/<name>.test.ts`.
5. Wire permission defaults in `src/permissions/types.ts` if needed.

### `MemoryProvider` — adding a new memory backend

The `MemoryProvider` interface (`src/memory/types.ts`) has eight methods: `inject`, `prefetch`, `sync`, `extract`, `search`, `upsert`, `get`, `forget`. The default `LocalFileProvider` (`src/memory/localFile.ts`) implements the full interface using `.alfred/memory/` on disk and SQLite FTS5 for search. To add a new backend (e.g. a Mem0 or Zep adapter):

1. Create `src/memory/providers/<name>.ts` implementing `MemoryProvider`.
2. Add tests in `tests/memory/<name>.test.ts`.
3. Register the provider in the config manager (`src/config/manager.ts`) under an `ALFRED_MEMORY_PROVIDER` env key.

### Provider — adding a new LLM provider

All LLM providers implement the shared interface in `src/providers/types.ts`. The Anthropic, OpenAI, and Mock implementations in `src/providers/` are the reference. To add a new provider:

1. Create `src/providers/<name>.ts` implementing the provider interface.
2. Add tests using the `MockProvider` pattern.
3. Register under a new `ALFRED_PROVIDER` value in `src/config/manager.ts`.

---

## Adding a new subsystem end-to-end

1. **Create the module** — new files under `src/<name>/`, staying within the 800-line file limit.
2. **Write tests first** — `tests/<name>/` using `MockProvider` and Bun's test runner.
3. **Validate at boundaries** — every external input validated with Zod before use.
4. **Wire into the engine** — hook into `src/query/engine.ts` (pre/post-turn), `src/orchestrator/runtime.ts` (workflow primitives), or `src/index.ts` (CLI command) as appropriate.
5. **Register tools** if the subsystem exposes model-facing capabilities (see `buildTool` above).
6. **Run the full suite** — `bun test` must stay green; `bun run typecheck` must stay clean.

::: warning Coverage gate
`bun test` will report coverage. New subsystems must not drop the project below 80 % line coverage. Add tests proportional to the implementation.
:::

---

## Commit and PR conventions

Commit messages follow conventional commits:

```
<type>: <description>

<optional body>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

Before opening a PR: all tests pass, `tsc --noEmit` is clean, and no `console.log` or hardcoded secrets are present.
