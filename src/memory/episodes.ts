/**
 * Episode store: write and query episodic memory records.
 *
 * Each episode is a JSON file under episodes/<id>.json. Episodes record what
 * the agent tried, what worked, and what failed, so future runs can avoid
 * repeating failed approaches (ADR 0001 §4 — MemGPT/Letta episodic tier).
 *
 * IDs are ISO-timestamp + 6-char random hex to guarantee uniqueness even for
 * sub-millisecond writes (e.g. tests). Queries return newest-first.
 */
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { Episode } from "./types.ts";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema (validate on read so corrupt files are skipped gracefully)
// ---------------------------------------------------------------------------

const EpisodeSchema = z.object({
  id: z.string(),
  goal: z.string(),
  approach: z.string(),
  worked: z.array(z.string()),
  failed: z.array(z.string()),
  verifyExit: z.string().optional(),
  gitSha: z.string().optional(),
  cost: z.number().optional(),
  ts: z.string(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

function generateId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomHex(3)}`;
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

// ---------------------------------------------------------------------------
// EpisodeStore
// ---------------------------------------------------------------------------

export class EpisodeStore {
  private readonly dir: string;

  constructor(episodesDir: string) {
    this.dir = episodesDir;
  }

  private episodePath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /**
   * Write a new episode record. The `id` and `ts` fields are generated
   * automatically; pass the rest of the episode data.
   */
  async write(data: Omit<Episode, "id" | "ts">): Promise<Episode> {
    await ensureDir(this.dir);
    const episode: Episode = {
      ...data,
      id: generateId(),
      ts: new Date().toISOString(),
    };
    await Bun.write(this.episodePath(episode.id), JSON.stringify(episode, null, 2) + "\n");
    return episode;
  }

  /**
   * Read a single episode by id. Returns null if not found or invalid.
   */
  async get(id: string): Promise<Episode | null> {
    const file = Bun.file(this.episodePath(id));
    if (!(await file.exists())) return null;
    let raw: unknown;
    try {
      raw = await file.json();
    } catch {
      return null;
    }
    const parsed = EpisodeSchema.safeParse(raw);
    return parsed.success ? (parsed.data as Episode) : null;
  }

  /**
   * List all episodes, newest-first, optionally limited to `limit` records.
   * Invalid / unreadable files are silently skipped.
   */
  async list(limit?: number): Promise<readonly Episode[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }

    const jsonFiles = files
      .filter((f) => f.endsWith(".json"))
      .sort() // ISO timestamps sort lexicographically = chronologically
      .reverse(); // newest-first

    // Scan newest-first across ALL files, stopping once `limit` VALID episodes
    // are collected. (Previously capped the candidate window at limit*2, so a
    // burst of corrupt/unparsable newest files could permanently shadow valid
    // older episodes and return fewer than `limit`.)
    const episodes: Episode[] = [];
    for (const filename of jsonFiles) {
      const id = filename.slice(0, -5); // strip .json
      const ep = await this.get(id);
      if (ep !== null) {
        episodes.push(ep);
        if (limit !== undefined && episodes.length >= limit) break;
      }
    }
    return episodes;
  }

  /**
   * Query episodes whose `goal` or `approach` contains any of the given terms
   * (case-insensitive substring match). Returns newest-first, up to `k`.
   */
  async query(terms: readonly string[], k: number): Promise<readonly Episode[]> {
    const all = await this.list();
    const lower = terms.map((t) => t.toLowerCase());
    const matched = all.filter((ep) => {
      const haystack =
        `${ep.goal} ${ep.approach} ${ep.worked.join(" ")} ${ep.failed.join(" ")}`.toLowerCase();
      return lower.some((t) => haystack.includes(t));
    });
    return matched.slice(0, k);
  }

  /**
   * Delete an episode record by id. No-op if not found.
   */
  async delete(id: string): Promise<void> {
    const path = this.episodePath(id);
    const file = Bun.file(path);
    if (await file.exists()) {
      await unlink(path);
    }
  }
}
