import { mkdir, readFile, writeFile, unlink, readdir } from "fs/promises";
import { join } from "path";

export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface MemoryEntry {
  name: string;
  type: MemoryType;
  description: string;
  content: string;
}

function toFileName(name: string): string {
  return `${name}.md`;
}

function formatFile(entry: MemoryEntry): string {
  return [
    "---",
    `name: ${entry.name}`,
    `type: ${entry.type}`,
    `description: ${entry.description}`,
    "---",
    "",
    entry.content,
  ].join("\n");
}

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

export class MemoryStore {
  constructor(private dir: string) {}

  async create(entry: MemoryEntry): Promise<MemoryEntry> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, toFileName(entry.name)), formatFile(entry), "utf-8");
    return { ...entry };
  }

  async get(name: string): Promise<MemoryEntry | null> {
    try {
      const raw = await readFile(join(this.dir, toFileName(name)), "utf-8");
      return parseFile(raw, toFileName(name));
    } catch {
      return null;
    }
  }

  async list(): Promise<MemoryEntry[]> {
    try {
      const files = await readdir(this.dir);
      const entries: MemoryEntry[] = [];
      for (const f of files.filter((n) => n.endsWith(".md"))) {
        const raw = await readFile(join(this.dir, f), "utf-8");
        const parsed = parseFile(raw, f);
        if (parsed) entries.push(parsed);
      }
      return entries;
    } catch {
      return [];
    }
  }

  async delete(name: string): Promise<boolean> {
    try {
      await unlink(join(this.dir, toFileName(name)));
      return true;
    } catch {
      return false;
    }
  }
}
