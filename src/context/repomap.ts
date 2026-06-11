/**
 * Repo-map builder inspired by Aider's repo-map (ADR 0002).
 *
 * Algorithm:
 *  1. Walk the repo (skipping non-source, vendor, hidden dirs).
 *  2. Extract defs/refs per file via heuristic regex (v1 seam for tree-sitter).
 *  3. Build a file→file directed graph: edge A→B when A has a ref that matches
 *     one of B's defs.
 *  4. Boost edge weights when the symbol appears in focusFiles or their names;
 *     downweight symbols defined in many files (ubiquitous names).
 *  5. PageRank the graph; render a compact listing of top files+symbols
 *     truncated to the token budget.
 */

import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { extractSymbols, langFor, type SymbolMap } from "./lib/symbols.ts";
import { pageRank, type Edge } from "./lib/pagerank.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RepomapOptions {
  /** Approximate token budget (chars / 4). Default: 1024 tokens. */
  readonly tokenBudget?: number;
  /** Files whose symbols and names get boosted during edge weighting. */
  readonly focusFiles?: readonly string[];
}

interface FileInfo {
  readonly absPath: string;
  readonly relPath: string;
  readonly symbols: SymbolMap;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TOKEN_BUDGET = 1024;
const CHARS_PER_TOKEN = 4;

/** Directories to skip entirely when walking the repo. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".alfred",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  "coverage",
  ".turbo",
  ".cache",
]);

/** Max files to analyse (prevents runaway cost on huge repos). */
const MAX_FILES = 2_000;

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

async function walkRepo(rootDir: string): Promise<readonly string[]> {
  const results: string[] = [];

  async function visit(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory
    }

    // Sort for determinism
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      // Skip hidden files/dirs
      if (entry.name.startsWith(".")) continue;

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await visit(join(dir, entry.name));
      } else if (entry.isFile()) {
        const filePath = join(dir, entry.name);
        if (langFor(filePath) !== null) {
          results.push(filePath);
          if (results.length >= MAX_FILES) return;
        }
      }
    }
  }

  await visit(rootDir);
  return Object.freeze(results);
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

function buildGraph(files: readonly FileInfo[], focusFiles: ReadonlySet<string>): readonly Edge[] {
  // Build lookup: defName → set of file relPaths that define it
  const defToFiles = new Map<string, string[]>();
  for (const f of files) {
    for (const def of f.symbols.defs) {
      const existing = defToFiles.get(def);
      if (existing !== undefined) {
        existing.push(f.relPath);
      } else {
        defToFiles.set(def, [f.relPath]);
      }
    }
  }

  // Build index: relPath → FileInfo
  const fileByRel = new Map<string, FileInfo>();
  for (const f of files) {
    fileByRel.set(f.relPath, f);
  }

  // Collect focus file base names for name-based boosting
  const focusBasenames = new Set<string>();
  for (const fp of focusFiles) {
    focusBasenames.add(fp.replace(/\\/g, "/").split("/").pop() ?? fp);
  }

  const edges: Edge[] = [];

  for (const srcFile of files) {
    for (const ref of srcFile.symbols.refs) {
      const targets = defToFiles.get(ref);
      if (targets === undefined || targets.length === 0) continue;

      // Ubiquity penalty: symbols defined in many files get downweighted
      const ubiquityPenalty = 1 / Math.sqrt(targets.length);

      // Focus boost: if ref symbol appears in focus file defs, or
      // focus file basename matches the target file name
      let focusBoost = 1;
      for (const tRel of targets) {
        if (focusFiles.has(tRel)) {
          focusBoost = 3;
          break;
        }
        const basename = tRel.split("/").pop() ?? tRel;
        if (focusBasenames.has(basename)) {
          focusBoost = 2;
          break;
        }
      }

      // Also boost if the source file is a focus file
      if (focusFiles.has(srcFile.relPath)) {
        focusBoost = Math.max(focusBoost, 2);
      }

      const weight = ubiquityPenalty * focusBoost;

      for (const tRel of targets) {
        if (tRel === srcFile.relPath) continue; // skip self-edges
        edges.push({ from: srcFile.relPath, to: tRel, weight });
      }
    }
  }

  return Object.freeze(edges);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderMap(
  rankedFiles: readonly [string, number][],
  fileByRel: Map<string, FileInfo>,
  charBudget: number,
): string {
  const lines: string[] = ["## Repo map\n"];
  let used = lines[0]!.length;

  for (const [relPath] of rankedFiles) {
    const info = fileByRel.get(relPath);
    if (info === undefined) continue;

    const header = relPath + "\n";
    const defs = info.symbols.defs;
    const defLine = defs.length > 0 ? "  " + defs.join(", ") + "\n" : "";
    const block = header + defLine;

    if (used + block.length > charBudget) break;
    lines.push(block);
    used += block.length;
  }

  return lines.join("");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a compact repo map for injection into the system prompt.
 *
 * The map lists source files ranked by how frequently their symbols are
 * referenced, biased toward `focusFiles`. Output is truncated to
 * ~`tokenBudget` tokens (estimated as chars / 4).
 */
export async function buildRepoMap(rootDir: string, opts: RepomapOptions = {}): Promise<string> {
  const tokenBudget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const charBudget = tokenBudget * CHARS_PER_TOKEN;

  // Normalise focusFiles to relative paths (or keep as-is if already relative)
  const focusSet = new Set<string>();
  for (const fp of opts.focusFiles ?? []) {
    try {
      focusSet.add(relative(rootDir, fp));
    } catch {
      focusSet.add(fp);
    }
  }

  // 1. Walk repo
  const absPaths = await walkRepo(rootDir);

  // 2. Extract symbols
  const files: FileInfo[] = [];
  for (const absPath of absPaths) {
    const relPath = relative(rootDir, absPath);
    const lang = langFor(absPath);
    if (lang === null) continue;

    let source: string;
    try {
      source = await Bun.file(absPath).text();
    } catch {
      continue; // unreadable file
    }

    const symbols = extractSymbols(source, lang);
    files.push(Object.freeze({ absPath, relPath, symbols }));
  }

  if (files.length === 0) {
    return "## Repo map\n(no source files found)\n";
  }

  // 3. Build graph
  const nodes = files.map((f) => f.relPath);
  const edges = buildGraph(files, focusSet);

  // 4. PageRank
  const scores = pageRank(nodes, edges);

  // 5. Sort by score descending, render
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);

  const fileByRel = new Map<string, FileInfo>();
  for (const f of files) {
    fileByRel.set(f.relPath, f);
  }

  return renderMap(ranked, fileByRel, charBudget);
}
