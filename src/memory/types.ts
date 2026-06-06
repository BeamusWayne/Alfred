/**
 * Memory v2 type contracts + Zod schemas.
 *
 * Defines the tiered memory model: Core (USER.md + MEMORY.md index, token-
 * budgeted), Recall (per-fact .md files with frontmatter), Episodic (JSON
 * records of past agent runs), and Archive (aged-out material). The
 * MemoryProvider interface is the single seam the engine touches — all
 * storage details stay behind it (ADR 0001 §4).
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Fact
// ---------------------------------------------------------------------------

export const FactTypeSchema = z.enum(["user", "feedback", "project", "reference"]);
export type FactType = z.infer<typeof FactTypeSchema>;

/**
 * Frontmatter carried in every facts/<slug>.md file and in the SQLite index.
 * `ttl` is an ISO-8601 date string: if today > ttl the fact is stale.
 * `scope` is an optional workspace-relative path; if the path disappears the
 * fact is stale.
 */
export const FactFrontmatterSchema = z.object({
  type: FactTypeSchema,
  scope: z.string().optional(),
  ts: z.string(), // ISO-8601
  ttl: z.string().optional(), // ISO-8601 expiry date
});
export type FactFrontmatter = z.infer<typeof FactFrontmatterSchema>;

/** A fully hydrated Fact record (frontmatter + body + derived fields). */
export interface Fact {
  readonly id: string; // === slug, e.g. "user-prefers-bun"
  readonly slug: string;
  readonly type: FactType;
  readonly scope?: string | undefined;
  readonly content: string; // body text (no frontmatter)
  readonly ts: string; // ISO-8601 creation/update timestamp
  readonly ttl?: string | undefined; // ISO-8601 expiry
}

// ---------------------------------------------------------------------------
// Episode
// ---------------------------------------------------------------------------

/**
 * An episodic memory: a record of one agent run. Written after the run
 * completes. The engine can query these to avoid repeating failed approaches.
 */
export interface Episode {
  readonly id: string; // ISO timestamp + random suffix
  readonly goal: string;
  readonly approach: string;
  readonly worked: readonly string[];
  readonly failed: readonly string[];
  readonly verifyExit?: string | undefined; // the exit criterion used
  readonly gitSha?: string | undefined;
  readonly cost?: number | undefined; // USD
  readonly ts: string; // ISO-8601
}

// ---------------------------------------------------------------------------
// MemoryBlock (rendered Core)
// ---------------------------------------------------------------------------

/**
 * The token-budgeted Core block injected into the system prompt. Stays small
 * enough that the stable prefix before the volatile env section never evicts
 * from the provider prompt cache (ADR 0001 §4).
 */
export interface MemoryBlock {
  /** The rendered markdown string to splice into the system prompt. */
  readonly text: string;
  /** Estimated token count (chars / 4, rounded up). */
  readonly estimatedTokens: number;
  /** True when the block was truncated to fit the budget. */
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------
// MemoryProvider interface
// ---------------------------------------------------------------------------

/**
 * The abstract surface the engine and tools use.  No implementation detail
 * leaks across this boundary.
 */
export interface MemoryProvider {
  /**
   * Stage 1 – inject: produce the token-budgeted Core block (USER.md +
   * MEMORY.md index). Called once per `buildSystemPrompt` before the volatile
   * env section so the prompt-cache prefix remains stable.
   */
  inject(): Promise<MemoryBlock>;

  /**
   * Stage 2 – prefetch: surface the k most relevant facts for a query.
   * Called at turn-start, before the model sees the message.
   */
  prefetch(query: string, k: number): Promise<readonly Fact[]>;

  /**
   * Stage 3 – sync: queue a candidate fact for potential persistence.
   * Called post-turn; the implementation decides whether to persist.
   */
  sync(candidate: Omit<Fact, "id">): Promise<void>;

  /**
   * Stage 4 – extract: curate the fact store: dedup, staleness-scan, GC.
   * Called when the agent run finishes (`done` event).
   */
  extract(): Promise<void>;

  // -- CRUD --

  /** Full-text search over stored facts. */
  search(query: string): Promise<readonly Fact[]>;

  /** Insert or update a fact by slug. Returns the persisted Fact. */
  upsert(fact: Omit<Fact, "id">): Promise<Fact>;

  /** Retrieve a single fact by id/slug, or null if absent. */
  get(id: string): Promise<Fact | null>;

  /** Permanently delete a fact by id/slug. No-op if absent. */
  forget(id: string): Promise<void>;

  /**
   * Find facts that may contradict or duplicate the given fact.
   * Useful before upserting to detect conflicts the model should review.
   */
  contradict(fact: Omit<Fact, "id">): Promise<readonly Fact[]>;
}
