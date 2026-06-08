/**
 * LocalFileProvider: file-first MemoryProvider over the .alfred/memory/ layout.
 *
 * Disk layout (rooted at `root`):
 *   USER.md                 core: stable prefs / conventions
 *   MEMORY.md               core: one-line index of every stored fact
 *   facts/<slug>.md         recall: one fact per file, YAML-ish frontmatter
 *   episodes/<id>.json      episodic records
 *   archive/                aged-out facts
 *   index.db                SQLite FTS5 index over facts
 *
 * Token budget: Core = USER.md + MEMORY.md, capped at CORE_TOKEN_BUDGET.
 * Token estimate: Math.ceil(chars / 4) — fast and good enough for budgeting.
 *
 * "Stale memory is the #1 cause of weird behavior" (Hermes Agent). extract()
 * scans every fact for expired TTL or a scope path that no longer exists, then
 * moves those facts to archive/ (ADR 0001 §4).
 */
import { mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { Fact, FactFrontmatter, MemoryBlock, MemoryProvider } from "./types.ts";
import { FactFrontmatterSchema } from "./types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CORE_TOKEN_BUDGET = 1500;
const FACTS_DIR = "facts";
const EPISODES_DIR = "episodes";
const ARCHIVE_DIR = "archive";
const USER_MD = "USER.md";
const MEMORY_MD = "MEMORY.md";
const INDEX_DB = "index.db";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Minimal YAML-ish frontmatter parser. Handles the subset we write:
 * string values, optional values. Does NOT handle nested objects or lists.
 * Returns { frontmatter, body } or throws if the block is malformed.
 */
function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
  const delim = "---";
  if (!raw.startsWith(delim)) {
    return { frontmatter: {}, body: raw };
  }
  const end = raw.indexOf("\n---", delim.length);
  if (end === -1) {
    return { frontmatter: {}, body: raw };
  }
  const yamlBlock = raw.slice(delim.length + 1, end).trim();
  const body = raw.slice(end + 4).replace(/^\n/, "");
  const frontmatter: Record<string, string> = {};
  for (const line of yamlBlock.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    if (key) frontmatter[key] = val;
  }
  return { frontmatter, body };
}

function serializeFrontmatter(fm: FactFrontmatter): string {
  const lines: string[] = ["---", `type: ${fm.type}`, `ts: ${fm.ts}`];
  if (fm.scope !== undefined) lines.push(`scope: ${fm.scope}`);
  if (fm.ttl !== undefined) lines.push(`ttl: ${fm.ttl}`);
  lines.push("---");
  return lines.join("\n") + "\n";
}

function slugToFilename(slug: string): string {
  return `${slug}.md`;
}

/**
 * A fact slug must be a single, safe path component. It is model-controlled
 * (memory_forget/memory_get take it straight from tool input, and those tools
 * are auto-approved), so without this an input like "../../etc/cron.d/x" would
 * let `join(factsDir, slug + ".md")` escape the workspace and read or delete
 * arbitrary *.md files. A slug with no path separators cannot traverse.
 */
function assertSafeSlug(slug: string): void {
  if (
    slug.length === 0 ||
    slug === "." ||
    slug === ".." ||
    slug.includes("/") ||
    slug.includes("\\") ||
    slug.includes("\0")
  ) {
    throw new Error(`invalid memory slug: ${JSON.stringify(slug)}`);
  }
}

function filenameToSlug(filename: string): string {
  return filename.endsWith(".md") ? filename.slice(0, -3) : filename;
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function safeReadText(path: string): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return file.text();
}

// ---------------------------------------------------------------------------
// LocalFileProvider
// ---------------------------------------------------------------------------

export class LocalFileProvider implements MemoryProvider {
  private readonly root: string;
  private db: Database | null = null;

  constructor(root: string) {
    this.root = root;
  }

  // -- Layout helpers -------------------------------------------------------

  private factsDir(): string {
    return join(this.root, FACTS_DIR);
  }

  private episodesDir(): string {
    return join(this.root, EPISODES_DIR);
  }

  private archiveDir(): string {
    return join(this.root, ARCHIVE_DIR);
  }

  private factPath(slug: string): string {
    assertSafeSlug(slug);
    return join(this.factsDir(), slugToFilename(slug));
  }

  private userMdPath(): string {
    return join(this.root, USER_MD);
  }

  private memoryMdPath(): string {
    return join(this.root, MEMORY_MD);
  }

  // -- SQLite FTS5 -----------------------------------------------------------

  private async openDb(): Promise<Database> {
    if (this.db !== null) return this.db;
    await ensureDir(this.root);
    const db = new Database(join(this.root, INDEX_DB), { create: true });
    db.run("PRAGMA journal_mode=WAL");
    db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts
      USING fts5(slug, type, scope, content, tokenize='unicode61')
    `);
    this.db = db;
    return db;
  }

  private async indexFact(fact: Fact): Promise<void> {
    const db = await this.openDb();
    db.run("DELETE FROM facts_fts WHERE slug = ?", [fact.slug]);
    db.run(
      "INSERT INTO facts_fts(slug, type, scope, content) VALUES (?, ?, ?, ?)",
      [fact.slug, fact.type, fact.scope ?? "", fact.content],
    );
  }

  private async deindexFact(slug: string): Promise<void> {
    const db = await this.openDb();
    db.run("DELETE FROM facts_fts WHERE slug = ?", [slug]);
  }

  // -- File I/O for facts ----------------------------------------------------

  private async readFactFile(slug: string): Promise<Fact | null> {
    const raw = await safeReadText(this.factPath(slug));
    if (raw === null) return null;
    return this.parseFactRaw(slug, raw);
  }

  private parseFactRaw(slug: string, raw: string): Fact | null {
    const { frontmatter, body } = parseFrontmatter(raw);
    const parsed = FactFrontmatterSchema.safeParse(frontmatter);
    if (!parsed.success) return null;
    const fm = parsed.data;
    return {
      id: slug,
      slug,
      type: fm.type,
      scope: fm.scope,
      content: body.trim(),
      ts: fm.ts,
      ttl: fm.ttl,
    };
  }

  private async writeFactFile(fact: Fact): Promise<void> {
    await ensureDir(this.factsDir());
    const fm: FactFrontmatter = {
      type: fact.type,
      ts: fact.ts,
      scope: fact.scope,
      ttl: fact.ttl,
    };
    const serialized = serializeFrontmatter(fm) + "\n" + fact.content + "\n";
    await Bun.write(this.factPath(fact.slug), serialized);
  }

  // -- MEMORY.md index -------------------------------------------------------

  private async rebuildMemoryIndex(): Promise<void> {
    await ensureDir(this.root);
    let entries: string[] = [];
    try {
      const files = await readdir(this.factsDir());
      const slugs = files
        .filter((f) => f.endsWith(".md"))
        .map(filenameToSlug);
      const facts = await Promise.all(slugs.map((s) => this.readFactFile(s)));
      entries = facts
        .filter((f): f is Fact => f !== null)
        .map((f) => `- [${f.slug}] (${f.type}): ${f.content.slice(0, 80).replace(/\n/g, " ")}`);
    } catch {
      // facts dir might not exist yet
    }
    const body =
      "# Memory Index\n\nOne line per stored fact. Use memory_search for full recall.\n\n" +
      (entries.length > 0 ? entries.join("\n") : "_No facts stored yet._") +
      "\n";
    await Bun.write(this.memoryMdPath(), body);
  }

  // -- MemoryProvider --------------------------------------------------------

  async inject(): Promise<MemoryBlock> {
    await ensureDir(this.root);
    const userText = (await safeReadText(this.userMdPath())) ?? "";
    const memoryText = (await safeReadText(this.memoryMdPath())) ?? "";

    const userSection = userText.trim()
      ? `## User Preferences & Conventions\n${userText.trim()}`
      : "";
    const memSection = memoryText.trim()
      ? `## Memory Index\n${memoryText.trim()}`
      : "";

    const parts = [userSection, memSection].filter(Boolean);
    const combined = parts.join("\n\n");
    const tokens = estimateTokens(combined);

    if (tokens <= CORE_TOKEN_BUDGET) {
      return { text: combined, estimatedTokens: tokens, truncated: false };
    }

    // Truncate to budget: keep USER.md full (it's small by design), truncate MEMORY.md index.
    const userTokens = estimateTokens(userSection);
    // Reserve tokens for the separator "\n\n" (1 token) + truncation note (10 tokens).
    const overhead = userSection.length > 0 ? 11 : 10;
    const budgetForMemory = CORE_TOKEN_BUDGET - userTokens - overhead;
    const charLimit = Math.max(0, budgetForMemory * 4);
    const TRUNCATION_NOTE = "\n… (truncated to fit token budget)";
    const truncatedMem =
      charLimit > 0 && memSection.length > 0
        ? memSection.slice(0, charLimit) + TRUNCATION_NOTE
        : "";

    const truncParts = [userSection, truncatedMem].filter(Boolean);
    const truncated = truncParts.join("\n\n");

    return {
      text: truncated,
      estimatedTokens: estimateTokens(truncated),
      truncated: true,
    };
  }

  async prefetch(query: string, k: number): Promise<readonly Fact[]> {
    const results = await this.search(query);
    return results.slice(0, k);
  }

  async sync(candidate: Omit<Fact, "id">): Promise<void> {
    // Check for near-duplicates before persisting
    const contradicting = await this.contradict(candidate);
    if (contradicting.length > 0) {
      // Overwrite the first contradicting fact (update-don't-duplicate policy)
      const existing = contradicting[0]!;
      const updated: Fact = {
        ...existing,
        content: candidate.content,
        ts: candidate.ts,
        ttl: candidate.ttl,
      };
      await this.writeFactFile(updated);
      await this.indexFact(updated);
    } else {
      await this.upsert(candidate);
    }
    await this.rebuildMemoryIndex();
  }

  async extract(): Promise<void> {
    let files: string[] = [];
    try {
      files = await readdir(this.factsDir());
    } catch {
      return; // nothing to extract
    }

    const now = new Date();
    const slugs = files.filter((f) => f.endsWith(".md")).map(filenameToSlug);
    await ensureDir(this.archiveDir());

    const staleArchiveOps: Promise<void>[] = [];

    for (const slug of slugs) {
      const fact = await this.readFactFile(slug);
      if (fact === null) continue;

      let stale = false;
      let reason = "";

      // TTL check
      if (fact.ttl !== undefined) {
        const expiry = new Date(fact.ttl);
        if (!isNaN(expiry.getTime()) && now > expiry) {
          stale = true;
          reason = `ttl expired (${fact.ttl})`;
        }
      }

      // Scope path check: if scope references a non-existent file/dir, flag stale
      if (!stale && fact.scope !== undefined) {
        const scopeFile = Bun.file(fact.scope);
        const exists = await scopeFile.exists();
        if (!exists) {
          stale = true;
          reason = `scope path no longer exists (${fact.scope})`;
        }
      }

      if (stale) {
        const archivePath = join(this.archiveDir(), slugToFilename(slug));
        // Annotate with staleness reason before archiving
        const raw = await safeReadText(this.factPath(slug));
        if (raw !== null) {
          const annotated = raw.trimEnd() + `\n\n<!-- archived: ${reason} at ${now.toISOString()} -->\n`;
          staleArchiveOps.push(
            (async () => {
              await Bun.write(archivePath, annotated);
              await unlink(this.factPath(slug));
              await this.deindexFact(slug);
            })(),
          );
        }
      }
    }

    await Promise.all(staleArchiveOps);

    // Dedup: find facts with identical content (simple exact-match dedup)
    // Re-read after archiving
    let remaining: string[] = [];
    try {
      remaining = (await readdir(this.factsDir()))
        .filter((f) => f.endsWith(".md"))
        .map(filenameToSlug);
    } catch {
      remaining = [];
    }

    const seen = new Map<string, string>(); // contentKey -> slug
    for (const slug of remaining) {
      const fact = await this.readFactFile(slug);
      if (fact === null) continue;
      const key = `${fact.type}:${fact.content.trim()}`;
      const prev = seen.get(key);
      if (prev !== undefined) {
        // Keep the newer one (by ts), archive the older
        const prevFact = await this.readFactFile(prev);
        const slugToRemove =
          prevFact !== null && fact.ts >= prevFact.ts ? prev : slug;
        const keepSlug = slugToRemove === prev ? slug : prev;
        seen.set(key, keepSlug);
        const archivePath = join(this.archiveDir(), slugToFilename(slugToRemove));
        const raw = await safeReadText(this.factPath(slugToRemove));
        if (raw !== null) {
          await Bun.write(archivePath, raw);
          await unlink(this.factPath(slugToRemove));
          await this.deindexFact(slugToRemove);
        }
      } else {
        seen.set(key, slug);
      }
    }

    await this.rebuildMemoryIndex();
  }

  async search(query: string): Promise<readonly Fact[]> {
    const db = await this.openDb();
    const rows = db
      .query<{ slug: string }, [string]>(
        `SELECT slug FROM facts_fts WHERE facts_fts MATCH ? ORDER BY rank LIMIT 20`,
      )
      .all(query);

    const facts = await Promise.all(rows.map((r) => this.readFactFile(r.slug)));
    return facts.filter((f): f is Fact => f !== null);
  }

  async upsert(candidate: Omit<Fact, "id">): Promise<Fact> {
    const fact: Fact = {
      ...candidate,
      id: candidate.slug,
    };
    await this.writeFactFile(fact);
    await this.indexFact(fact);
    await this.rebuildMemoryIndex();
    return fact;
  }

  async get(id: string): Promise<Fact | null> {
    return this.readFactFile(id);
  }

  async forget(id: string): Promise<void> {
    const path = this.factPath(id);
    const file = Bun.file(path);
    if (await file.exists()) {
      await unlink(path);
    }
    await this.deindexFact(id);
    await this.rebuildMemoryIndex();
  }

  async contradict(candidate: Omit<Fact, "id">): Promise<readonly Fact[]> {
    // Strategy: search for facts with the same scope + type, or search
    // content terms to find semantic neighbours that might conflict.
    const results: Map<string, Fact> = new Map();

    // 1. Exact scope + type match
    let files: string[] = [];
    try {
      files = await readdir(this.factsDir());
    } catch {
      return [];
    }
    for (const file of files.filter((f) => f.endsWith(".md"))) {
      const slug = filenameToSlug(file);
      const fact = await this.readFactFile(slug);
      if (fact === null) continue;
      if (
        fact.type === candidate.type &&
        fact.scope === candidate.scope &&
        fact.slug === candidate.slug
      ) {
        results.set(slug, fact);
      }
    }

    // 2. FTS search on first significant words of the content
    const terms = candidate.content
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 5)
      .join(" OR ");

    if (terms.length > 0) {
      try {
        const searched = await this.search(terms);
        for (const f of searched) {
          if (f.type === candidate.type && !results.has(f.slug)) {
            results.set(f.slug, f);
          }
        }
      } catch {
        // FTS may fail on unusual characters — safe to ignore here
      }
    }

    return Array.from(results.values());
  }

  /** Close the SQLite connection (for testing / cleanup). */
  close(): void {
    if (this.db !== null) {
      this.db.close();
      this.db = null;
    }
  }

}
