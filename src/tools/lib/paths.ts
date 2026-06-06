/**
 * Filesystem path containment (ADR 0003): every file tool resolves user paths
 * through `resolveInside(root, p)`, which throws if the result escapes `root`.
 * No more reading `/etc/passwd` or writing `../../.bashrc`.
 */
import { isAbsolute, relative, resolve } from "node:path";

export class PathEscapeError extends Error {
  constructor(
    readonly requested: string,
    readonly root: string,
  ) {
    super(`path '${requested}' resolves outside the workspace root '${root}'`);
    this.name = "PathEscapeError";
  }
}

/** Resolve `p` (relative to `root` unless absolute) and assert it stays inside `root`. */
export function resolveInside(root: string, p: string): string {
  const absRoot = resolve(root);
  const abs = isAbsolute(p) ? resolve(p) : resolve(absRoot, p);
  const rel = relative(absRoot, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
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
