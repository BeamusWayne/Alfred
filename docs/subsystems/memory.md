# Memory

Alfred's Memory v2 system gives the agent a persistent, curated fact store that survives across runs. Facts live on disk under `.alfred/memory/`, are indexed by SQLite FTS5 for full-text search, and are surfaced to the model through a four-stage lifecycle. The model can read, write, and delete facts through three dedicated tools.

**Source files:** `src/memory/types.ts`, `src/memory/localFile.ts`, `src/memory/episodes.ts`, `src/tools/memoryTool.ts`.  
**Design:** ADR 0001 §4.

---

## On-disk layout

Every workspace gets its own isolated store rooted at `${workingDir}/.alfred/memory/`:

```text
.alfred/memory/
  USER.md              # Core: stable user prefs and conventions (hand-edited or model-written)
  MEMORY.md            # Core: auto-generated one-line index of every stored fact
  facts/
    <slug>.md          # Recall: one fact per file, YAML frontmatter + body
  episodes/
    <id>.json          # Episodic: one record per completed agent run
  archive/             # Aged-out or deduped facts (annotated and moved here by extract())
  index.db             # SQLite FTS5 index over facts (unicode61 tokeniser)
```

The `LocalFileProvider` class in `src/memory/localFile.ts` implements this layout. It is constructed with a `root` path and opens the SQLite database lazily on first use (with `PRAGMA journal_mode=WAL`).

---

## Tiers

### Core (token-budgeted)

The Core tier consists of `USER.md` and `MEMORY.md`. It is injected into the system prompt once per session via `inject()`. The combined text is capped at **1,500 estimated tokens** (`Math.ceil(chars / 4)`).

When the combined text exceeds the budget, `USER.md` content is kept whole (it is small by design) and `MEMORY.md` is truncated with a `"… (truncated to fit token budget)"` suffix. The `MemoryBlock` return value carries an `estimatedTokens` count and a `truncated: boolean` flag.

`MEMORY.md` is automatically rebuilt by `rebuildMemoryIndex()` after every write: it contains one line per stored fact in the form:

```
- [<slug>] (<type>): <first 80 chars of content>
```

### Recall (per-fact files)

Each fact lives in `facts/<slug>.md` with a minimal YAML frontmatter block:

```
---
type: user
ts: 2026-06-06T10:00:00.000Z
scope: src/query
ttl: 2026-12-31
---

User prefers Bun over Node for all scripts.
```

Facts are looked up by slug, searched via FTS5, and hydrated into the `Fact` interface on read.

### Archival

`extract()` scans every file in `facts/` for staleness and exact-duplicate content. Stale facts are annotated with an HTML comment (`<!-- archived: <reason> at <iso-date> -->`) and moved to `archive/`. The FTS5 index is updated to remove archived slugs.

### Episodic

Episodes (see [Episodes](#episodes)) live separately in `episodes/<id>.json` and are not included in the Core token budget.

---

## `Fact` and `Episode` shapes

### `Fact`

```ts
interface Fact {
  readonly id: string;       // === slug, e.g. "user-prefers-bun"
  readonly slug: string;
  readonly type: FactType;   // "user" | "feedback" | "project" | "reference"
  readonly scope?: string;   // workspace-relative path (optional)
  readonly content: string;  // body text (no frontmatter)
  readonly ts: string;       // ISO-8601 creation/update timestamp
  readonly ttl?: string;     // ISO-8601 expiry date (optional)
}
```

`FactFrontmatter` carries the same fields except `id`, `slug`, and `content`; it is the subset serialised to the YAML block.

### `Episode`

```ts
interface Episode {
  readonly id: string;          // ISO timestamp + 6-char random hex
  readonly goal: string;
  readonly approach: string;
  readonly worked: readonly string[];
  readonly failed: readonly string[];
  readonly verifyExit?: string;
  readonly gitSha?: string;
  readonly cost?: number;       // USD
  readonly ts: string;          // ISO-8601
}
```

---

## `MemoryProvider` interface

`src/memory/types.ts` defines the single abstract surface that the engine and tools use. No implementation detail crosses this boundary.

```ts
interface MemoryProvider {
  inject(): Promise<MemoryBlock>;
  prefetch(query: string, k: number): Promise<readonly Fact[]>;
  sync(candidate: Omit<Fact, "id">): Promise<void>;
  extract(): Promise<void>;

  search(query: string): Promise<readonly Fact[]>;
  upsert(fact: Omit<Fact, "id">): Promise<Fact>;
  get(id: string): Promise<Fact | null>;
  forget(id: string): Promise<void>;
  contradict(fact: Omit<Fact, "id">): Promise<readonly Fact[]>;
}
```

---

## The 4-stage lifecycle

### Stage 1 — inject

`inject()` is called once per run when building the system prompt. It reads `USER.md` and `MEMORY.md`, applies the 1,500-token budget, and returns a `MemoryBlock`. The result is spliced into the stable prefix of the system prompt, before any volatile environment section, so it lands in the provider's prompt cache.

### Stage 2 — prefetch

`prefetch(query, k)` is called at turn-start, before the model sees the user message. It delegates to `search(query)` and returns up to `k` relevant `Fact` objects. These can be rendered into the context message for the upcoming turn.

`LocalFileProvider.prefetch` is a thin wrapper: `search(query).then(results => results.slice(0, k))`.

### Stage 3 — sync

`sync(candidate)` is called post-turn. It decides whether to persist a candidate fact:

1. Calls `contradict(candidate)` to find existing facts with the same slug, same type+scope, or similar content terms (via FTS5).
2. If contradicting facts exist, it **overwrites the first one** (update-don't-duplicate policy), preserving the existing slug.
3. If none exist, it calls `upsert(candidate)`.
4. Always rebuilds `MEMORY.md` after writing.

### Stage 4 — extract

`extract()` is called when the agent run finishes. It:

1. **TTL sweep:** reads every `facts/<slug>.md`, parses the `ttl` field, and archives any fact whose expiry date is before now.
2. **Scope sweep:** if a fact has a `scope` path, checks whether that path exists on disk (`Bun.file(scope).exists()`). Missing scope → stale.
3. **Dedup:** after archiving, scans remaining facts for identical `type + content` pairs. Keeps the newer one (by `ts`), archives the older.
4. Rebuilds `MEMORY.md`.

All three sub-phases run in the same `extract()` call. Archive operations run in parallel (`Promise.all`).

---

## SQLite FTS5 search

`LocalFileProvider` opens `index.db` with a single virtual table:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts
USING fts5(slug, type, scope, content, tokenize='unicode61')
```

`search(query)` runs:

```sql
SELECT slug FROM facts_fts WHERE facts_fts MATCH ? ORDER BY rank LIMIT 20
```

`indexFact` deletes then re-inserts the row for that slug (upsert via DELETE + INSERT). `deindexFact` issues a bare DELETE. All database access is through Bun's `bun:sqlite` bindings.

---

## Episodes

`EpisodeStore` in `src/memory/episodes.ts` manages `episodes/<id>.json` files. IDs are `<ISO-timestamp-sanitised>-<6-hex-char>` to guarantee uniqueness for sub-millisecond writes. Episode files are validated on read with a Zod schema; corrupt files are silently skipped.

Key operations:

- `write(data)` — assigns `id` and `ts`, writes `<id>.json`.
- `list(limit?)` — reads all episode files sorted lexicographically (ISO timestamps sort chronologically), returned newest-first.
- `query(terms, k)` — case-insensitive substring match across `goal + approach + worked + failed`; returns up to `k` newest matches.
- `delete(id)` — unlinks the file; no-op if absent.

---

## Model-facing tools

Three tools in `src/tools/memoryTool.ts` expose the memory store to the model. Each tool is constructed with `buildTool` and rooted at `${ctx.workingDir}/.alfred/memory`. A module-level `Map<string, LocalFileProvider>` caches one provider instance per working directory.

### `memory_search`

Full-text search over stored facts. Read-only and concurrency-safe — runs in parallel with other read-only tools.

```
Input:  { query: string, k?: number (1–50, default 10) }
Output: One fact per section, formatted as:
        [slug] type=<type> [scope=<scope>] ts=<ts>
        <content>
```

### `memory_upsert`

Insert or update a fact. Not read-only; runs serially.

```
Input:  { slug: string, type: FactType, content: string, scope?: string, ttl?: string }
Output: "Stored fact [<slug>] (<type>) at <ts>"
```

The slug must be lowercase alphanumeric + hyphens (`/^[a-z0-9-]+$/`). The tool stamps `ts` as `new Date().toISOString()` at call time and delegates to `provider.upsert()`.

::: tip Update-don't-duplicate policy
The tool description instructs the model: "Check for contradictions with `memory_search` before writing." Upserting an existing slug overwrites it cleanly.
:::

### `memory_forget`

Permanently delete a fact by slug. Not read-only; runs serially.

```
Input:  { slug: string }
Output: "Deleted fact [<slug>] (no-op if it did not exist)"
```

Delegates to `provider.forget()`, which unlinks the file, removes the FTS5 row, and rebuilds `MEMORY.md`.

---

## See also

- [Agent Loop](/subsystems/agent-loop) — where `inject()` feeds the system prompt and `extract()` is called on the `done` event
- [Orchestrator](/subsystems/orchestrator) — memory providers can be wired through `RuntimeOptions`
- ADR 0001 §4 — full design rationale and tier definitions
