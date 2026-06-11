/**
 * Filesystem path containment (ADR 0003): every file tool resolves user paths
 * through `resolveInside(root, p)`, which throws if the result escapes `root`.
 * No more reading `/etc/passwd` or writing `../../.bashrc`.
 *
 * Two layers of defence:
 *   1. A lexical check on the resolved path — fast, and the only check possible
 *      when the target (or root) does not exist yet (e.g. a new-file write).
 *   2. A symlink-aware check that resolves real paths where the filesystem
 *      allows it, so a symlink *inside* the workspace cannot be followed to a
 *      location outside it. Pure lexical resolution (`path.resolve`) does not
 *      follow symlinks, so without this a `link -> /etc` inside the root would
 *      let `link/passwd` escape.
 */
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

export class PathEscapeError extends Error {
  constructor(
    readonly requested: string,
    readonly root: string,
  ) {
    super(`path '${requested}' resolves outside the workspace root '${root}'`);
    this.name = "PathEscapeError";
  }
}

/**
 * True when `abs` is `root` itself or lexically nested under it. Crucially this
 * is NOT `rel.startsWith("..")`: a sibling like `<root>/../x` resolves to a rel
 * of `../x` (escape) but a legitimately-nested file literally named `..foo`
 * resolves to `..foo` (contained). The distinction is the path separator.
 */
function lexicallyInside(absRoot: string, abs: string): boolean {
  if (abs === absRoot) return true;
  const rel = relative(absRoot, abs);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

/**
 * Realpath the longest existing prefix of `abs`, then re-append the components
 * that do not exist yet. Returns `undefined` if nothing along the path exists
 * (so there is no symlink to follow and the lexical check is authoritative).
 */
function realpathNearestExisting(abs: string): string | undefined {
  let cur = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length > 0 ? resolve(real, ...tail) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return undefined; // reached the fs root; nothing existed
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

/** Resolve `p` (relative to `root` unless absolute) and assert it stays inside `root`. */
export function resolveInside(root: string, p: string): string {
  const absRoot = resolve(root);
  const abs = isAbsolute(p) ? resolve(p) : resolve(absRoot, p);

  // Layer 1 — lexical containment (always applicable).
  if (!lexicallyInside(absRoot, abs)) {
    throw new PathEscapeError(p, absRoot);
  }

  // Layer 2 — symlink-aware containment, best-effort. If the root cannot be
  // realpath'd (it does not exist), there are no symlinks to escape through and
  // the lexical check above is sufficient.
  let realRoot: string;
  try {
    realRoot = realpathSync(absRoot);
  } catch {
    return abs;
  }
  const realTarget = realpathNearestExisting(abs);
  if (realTarget !== undefined && !lexicallyInside(realRoot, realTarget)) {
    throw new PathEscapeError(p, absRoot);
  }

  return abs;
}

export function isInside(root: string, p: string): boolean {
  try {
    resolveInside(root, p);
    return true;
  } catch {
    return false;
  }
}
