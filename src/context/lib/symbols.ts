/**
 * Heuristic symbol extractor for JS/TS source files (ADR 0002).
 *
 * v1: pure regex — good enough for ranking. A tree-sitter backend can replace
 * `extractSymbols` later without changing the public interface; the `lang`
 * parameter is the documented seam for that upgrade.
 *
 * Defs: names bound at module scope via `export`, `function`, or `class`.
 * Refs: every identifier token that is NOT a keyword and NOT in this file's defs.
 */

/** Symbol extraction result. Both arrays are de-duplicated and readonly. */
export interface SymbolMap {
  readonly defs: readonly string[];
  readonly refs: readonly string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** JS/TS reserved keywords we skip when collecting refs. */
const KEYWORDS = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "null",
  "of",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "async",
  "await",
  "interface",
  "enum",
  "as",
  "implements",
  "readonly",
  "abstract",
  "declare",
  "namespace",
  "module",
  "keyof",
  "infer",
  "never",
  "unknown",
  "any",
  "boolean",
  "number",
  "string",
  "symbol",
  "object",
  "bigint",
  "void",
  "satisfies",
  "override",
]);

/**
 * Patterns that capture a symbol name (group 1) at the top level.
 *
 * v1 covers:
 *   export (default)? (function|class|const|let|var|interface|type|enum) NAME
 *   function NAME (top-level, not indented)
 *   class NAME    (top-level, not indented)
 */
const DEF_PATTERNS: readonly RegExp[] = [
  // export default function/class Name
  /^export\s+default\s+(?:function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/m,
  // export (async) function/class/const/let/var/interface/type/enum Name
  /^export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm,
  // top-level function Name (line starts without indent)
  /^(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm,
  // top-level class Name
  /^class\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm,
];

/** Extract all definition names from a source string. */
function extractDefs(source: string): readonly string[] {
  const names = new Set<string>();
  for (const pattern of DEF_PATTERNS) {
    // Reset lastIndex for global patterns on each call
    const re = new RegExp(pattern.source, pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const name = m[1];
      if (name !== undefined && name.length > 0) {
        names.add(name);
      }
    }
  }
  return Object.freeze([...names]);
}

/** Tokenise source into identifier-like strings, filter keywords + defs. */
function extractRefs(source: string, defs: ReadonlySet<string>): readonly string[] {
  // Strip line comments and string literals (best-effort; good enough for v1)
  const stripped = source
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/"(?:[^"\\]|\\.)*"/g, " ")
    .replace(/'(?:[^'\\]|\\.)*'/g, " ")
    .replace(/`(?:[^`\\]|\\.)*`/g, " ");

  const seen = new Set<string>();
  const ident = /\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = ident.exec(stripped)) !== null) {
    const name = m[1];
    if (name !== undefined && !KEYWORDS.has(name) && !defs.has(name)) {
      seen.add(name);
    }
  }
  return Object.freeze([...seen]);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract definition and reference symbols from JS/TS source.
 *
 * `lang` is unused in v1 (regex is the same for ts/js) but forms the
 * documented seam for a tree-sitter upgrade: a future backend can branch on
 * `lang` to use the correct grammar without changing call sites.
 */
export function extractSymbols(source: string, _lang: "ts" | "js"): SymbolMap {
  const defs = extractDefs(source);
  const defSet = new Set(defs);
  const refs = extractRefs(source, defSet);
  return Object.freeze({ defs, refs });
}

/**
 * Return the language tag for a file path, or `null` if the file should be
 * skipped (not a JS/TS source).
 */
export function langFor(filePath: string): "ts" | "js" | null {
  const lower = filePath.toLowerCase();
  if (
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".mts") ||
    lower.endsWith(".cts")
  ) {
    return "ts";
  }
  if (
    lower.endsWith(".js") ||
    lower.endsWith(".jsx") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs")
  ) {
    return "js";
  }
  return null;
}
