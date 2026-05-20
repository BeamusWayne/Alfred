import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { type MemoryEntry, type MemoryType } from "./store.js";

function parseFile(raw: string, fileName: string): MemoryEntry | null {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return null;

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }

  const name = frontmatter.name || fileName.replace(/\.md$/, "");
  const type = (frontmatter.type as MemoryType) || "user";
  const description = frontmatter.description || "";

  return { name, type, description, content: match[2].trim() };
}

export async function searchMemories(dir: string, query: string): Promise<MemoryEntry[]> {
  const lowerQuery = query.toLowerCase();
  const results: MemoryEntry[] = [];

  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  for (const f of files.filter((n) => n.endsWith(".md"))) {
    const raw = await readFile(join(dir, f), "utf-8");
    const entry = parseFile(raw, f);
    if (!entry) continue;

    const searchable = `${entry.name} ${entry.description} ${entry.content}`.toLowerCase();
    if (searchable.includes(lowerQuery)) {
      results.push(entry);
    }
  }
  return results;
}
