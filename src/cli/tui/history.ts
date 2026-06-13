/**
 * Prompt history for the TUI — up/down at the first/last line of the input
 * recalls previous prompts (Claude Code parity). Persisted one JSON string
 * per line under `.alfred/history` so multi-line prompts survive restarts.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const MAX_ENTRIES = 200;

export function historyPath(workingDir: string): string {
  return join(workingDir, ".alfred", "history");
}

export function loadHistory(path: string): readonly string[] {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf-8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as unknown)
      .filter((v): v is string => typeof v === "string")
      .slice(-MAX_ENTRIES);
  } catch {
    return []; // a corrupt history file must never block the prompt
  }
}

/**
 * Navigation cursor over the history plus the in-progress draft. Immutable:
 * every move returns a new session. `index === entries.length` means "the
 * draft" (not yet in history).
 */
export interface HistorySession {
  readonly entries: readonly string[];
  readonly index: number;
  readonly draft: string;
}

export function startSession(entries: readonly string[], draft: string): HistorySession {
  return { entries, index: entries.length, draft };
}

export function up(s: HistorySession, currentText: string): { session: HistorySession; text: string } | null {
  if (s.index === 0) return null;
  // Leaving the draft for the first time captures it for the way back down.
  const session: HistorySession = {
    ...s,
    draft: s.index === s.entries.length ? currentText : s.draft,
    index: s.index - 1,
  };
  return { session, text: session.entries[session.index] ?? "" };
}

export function down(s: HistorySession): { session: HistorySession; text: string } | null {
  if (s.index >= s.entries.length) return null;
  const index = s.index + 1;
  const session: HistorySession = { ...s, index };
  return { session, text: index === s.entries.length ? s.draft : (s.entries[index] ?? "") };
}

/** Append a submitted prompt (deduped against the latest entry). */
export function push(entries: readonly string[], text: string): readonly string[] {
  if (entries[entries.length - 1] === text) return entries;
  return [...entries, text].slice(-MAX_ENTRIES);
}

/** Best-effort persist — history loss must never fail a session. */
export async function saveHistory(path: string, entries: readonly string[]): Promise<void> {
  try {
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  } catch {
    // best-effort
  }
}
