/**
 * macOS Seatbelt profile generator for the OS sandbox layer.
 *
 * ADR 0001 §7.3 (OS sandbox — two orthogonal axes: sandbox × approval).
 *
 * Produces a Seatbelt `.sb` profile string that denies everything by default,
 * allows all process operations and file reads, restricts writes to an explicit
 * allow-list of paths, and optionally allows or denies network access.
 *
 * This module is a pure string builder with no I/O side-effects.
 */
import { isAbsolute } from "node:path";

/** Policy passed to the Seatbelt profile generator. */
export interface SandboxPolicy {
  /** Absolute paths to which file-write operations are permitted. */
  readonly writablePaths: readonly string[];
  /** When true, outbound network access is permitted; otherwise denied. */
  readonly allowNetwork: boolean;
}

/**
 * Escape a path for inclusion in a Seatbelt literal string.
 * Seatbelt uses TinyScheme; double-quotes and backslashes must be escaped.
 */
function escapeSbPath(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** True if `s` contains any C0 control character or DEL (0x7f). */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * A writable path is only safe to emit as a `subpath` rule if it is absolute
 * (Seatbelt's `subpath` silently never matches a relative path — granting a
 * useless rule) and free of control characters (a newline/NUL would break out
 * of, or inject into, the TinyScheme string literal). Anything else is dropped
 * rather than emitted: the sandbox fails CLOSED (the write stays denied) instead
 * of producing a malformed or silently-ineffective profile. Validating at this
 * security boundary keeps a future caller's bad input from weakening it.
 */
function isSafeWritablePath(path: string): boolean {
  return isAbsolute(path) && !hasControlChar(path);
}

/**
 * Generate a macOS Seatbelt (sandbox-exec) profile string from `policy`.
 *
 * The profile:
 *   - Denies all operations by default.
 *   - Allows all `process*` operations (fork, exec, signal, …).
 *   - Allows all `file-read*` operations.
 *   - Allows `file-write*` restricted to `policy.writablePaths` subpaths
 *     (absolute, control-char-free paths only; anything else is dropped).
 *   - Allows or denies `network*` based on `policy.allowNetwork`.
 */
export function seatbeltProfile(policy: SandboxPolicy): string {
  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow file-read*)",
  ];

  for (const p of policy.writablePaths) {
    if (!isSafeWritablePath(p)) continue; // fail closed: never emit an invalid rule
    lines.push(`(allow file-write* (subpath "${escapeSbPath(p)}"))`);
  }

  if (policy.allowNetwork) {
    lines.push("(allow network*)");
  } else {
    lines.push("(deny network*)");
  }

  return lines.join("\n");
}
