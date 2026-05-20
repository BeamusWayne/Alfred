import * as fs from "fs";
import * as path from "path";

const CLAUDE_MD_NAMES = ["CLAUDE.md", ".claude/CLAUDE.md"];

export interface ClaudeMdResult {
  content: string;
  filePath: string;
}

export function discoverClaudeMds(workingDir: string): ClaudeMdResult[] {
  const results: ClaudeMdResult[] = [];
  let current = workingDir;

  while (true) {
    for (const name of CLAUDE_MD_NAMES) {
      const filePath = path.join(current, name);
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, "utf-8");
          results.push({ content, filePath });
        } catch {
          // Skip unreadable files
        }
      }
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return results.reverse();
}

export function formatClaudeMds(files: ClaudeMdResult[]): string {
  if (files.length === 0) return "";
  return files
    .map((f) => `--- ${f.filePath} ---\n${f.content}`)
    .join("\n\n");
}
