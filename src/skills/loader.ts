import { readdir, readFile } from "fs/promises";
import { join, basename } from "path";
import { registerSkill, type Skill } from "./store.js";
import { registerCommand } from "../commands/types.js";

interface LoadOptions {
  registerAsCommands?: boolean;
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } | null {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return null;

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    frontmatter[key] = value;
  }
  return { frontmatter, body: match[2] };
}

export async function loadSkillsFromDir(dir: string, options?: LoadOptions): Promise<Skill[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const loaded: Skill[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = join(dir, entry);
    const raw = await readFile(filePath, "utf-8");
    const parsed = parseFrontmatter(raw);
    if (!parsed) continue;

    const { frontmatter, body } = parsed;
    const name = frontmatter.name || basename(entry, ".md");
    const description = frontmatter.description;

    if (!description) continue;

    const skill: Skill = { name, description, content: body.trim() };
    registerSkill(skill);
    loaded.push(skill);

    if (options?.registerAsCommands) {
      registerCommand({
        name,
        description,
        async execute(args: string) {
          const content = body.trim().replace(/\{\{args\}\}/g, args);
          return { type: "text", content };
        },
      });
    }
  }
  return loaded;
}
