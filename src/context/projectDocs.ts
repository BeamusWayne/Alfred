/**
 * Discover project instruction files (AGENTS.md / CLAUDE.md) from the
 * filesystem root down to the working directory, so the most specific file is
 * loaded last and wins (ADR 0001 §7.1). These are injected as *guidance*, not
 * as part of the immutable system identity.
 */
import { dirname, resolve } from "node:path";

const NAMES = ["AGENTS.md", "CLAUDE.md"] as const;
const MAX_DOC_CHARS = 12_000;

export interface ProjectDoc {
  readonly path: string;
  readonly content: string;
}

function ancestorDirs(workingDir: string): string[] {
  const dirs: string[] = [];
  let d = resolve(workingDir);
  for (;;) {
    dirs.push(d);
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return dirs.reverse(); // root first → cwd last (most specific wins)
}

export async function discoverProjectDocs(workingDir: string): Promise<ProjectDoc[]> {
  const docs: ProjectDoc[] = [];
  for (const dir of ancestorDirs(workingDir)) {
    for (const name of NAMES) {
      const file = Bun.file(`${dir}/${name}`);
      if (await file.exists()) {
        let content = await file.text();
        if (content.length > MAX_DOC_CHARS) {
          content = content.slice(0, MAX_DOC_CHARS) + "\n… (truncated)";
        }
        docs.push({ path: `${dir}/${name}`, content });
      }
    }
  }
  return docs;
}
