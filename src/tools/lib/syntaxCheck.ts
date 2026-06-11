/**
 * Post-edit syntax check dispatched by file extension (ADR 0002 step 2).
 *
 * Runs a fast, dependency-light parse before any write so broken code is never
 * persisted.  The check is deliberately conservative: extensions that have no
 * registered checker pass through unconditionally.
 *
 * Extension seam: to add support for more languages, extend `LOADER_MAP` for
 * Bun-natively-supported loaders, or add entries to `EXTRA_CHECKERS` below the
 * "add tree-sitter grammars here for other languages" comment.
 */

/** Bun transpiler loader values we actually use. */
type BunLoader = "ts" | "tsx" | "js" | "jsx";

/** Result type: a discriminated union so callers must handle both branches. */
export type SyntaxCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

/** Maps file extensions to the Bun transpiler loader that can parse them. */
export const LOADER_MAP: Readonly<Record<string, BunLoader>> = {
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
} as const;

/**
 * Returns true when `checkSyntax` will actually validate the file rather than
 * pass it through.  Useful for callers that want to gate on checkability.
 */
export function isCheckable(path: string): boolean {
  const ext = extensionOf(path);
  return ext === ".json" || Object.hasOwn(LOADER_MAP, ext);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (dot === -1 || dot < slash) return "";
  return path.slice(dot).toLowerCase();
}

function coerceMessage(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message.split("\n")[0]!.trim();
  return String(thrown).split("\n")[0]!.trim();
}

function checkWithTranspiler(loader: BunLoader, content: string): SyntaxCheckResult {
  try {
    new Bun.Transpiler({ loader }).transformSync(content);
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: coerceMessage(err) };
  }
}

function checkJson(content: string): SyntaxCheckResult {
  try {
    JSON.parse(content);
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: coerceMessage(err) };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate `content` for `path` by dispatching on file extension.
 *
 * - TypeScript / TSX / JavaScript / JSX → Bun.Transpiler
 * - JSON → JSON.parse
 * - Anything else → `{ ok: true }` (conservative: never block unknown languages)
 *
 * Empty content always returns `{ ok: true }` (an empty file is valid for
 * every language we know about).
 *
 * add tree-sitter grammars here for other languages
 */
export function checkSyntax(path: string, content: string): SyntaxCheckResult {
  if (content.length === 0) return { ok: true };

  const ext = extensionOf(path);

  const loader = (LOADER_MAP as Record<string, BunLoader | undefined>)[ext];
  if (loader !== undefined) {
    return checkWithTranspiler(loader, content);
  }

  if (ext === ".json") {
    return checkJson(content);
  }

  // Unknown / no extension — pass through conservatively.
  return { ok: true };
}
