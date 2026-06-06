/**
 * OS sandbox integration for the Alfred CLI.
 *
 * ADR 0001 §7.3 (OS sandbox — two orthogonal axes: sandbox × approval).
 *
 * Wraps an arbitrary shell command with an OS-level sandbox:
 *   - macOS ("darwin"): uses `sandbox-exec` with a generated Seatbelt profile.
 *   - Linux and all other platforms: transparent passthrough (documented no-op
 *     seam; a bwrap/Landlock backend is planned for a later release).
 *
 * The caller opts in via `ALFRED_SANDBOX=1`; when the sandbox is unavailable
 * on the current platform the command passes through unchanged.
 */

import { seatbeltProfile } from "./seatbelt.ts";
export type { SandboxPolicy } from "./seatbelt.ts";
import type { SandboxPolicy } from "./seatbelt.ts";

/** Result of wrapping a command with the sandbox. */
export interface WrapResult {
  /** The argv array ready to be spawned (e.g. via `Bun.spawn`). */
  readonly argv: readonly string[];
  /** True when a sandbox wrapper was applied; false for transparent passthrough. */
  readonly wrapped: boolean;
}

/**
 * Returns true when an OS sandbox is available on `platform`.
 *
 * v1 supports macOS only (`"darwin"`). All other platforms return false.
 */
export function sandboxAvailable(platform?: NodeJS.Platform): boolean {
  return (platform ?? process.platform) === "darwin";
}

/**
 * Wrap `command` with the OS sandbox for `policy` on `platform`.
 *
 * On macOS:
 *   Returns `{ argv: ["sandbox-exec", "-p", <profile>, "sh", "-c", command],
 *              wrapped: true }`.
 *
 * On all other platforms:
 *   Returns `{ argv: ["sh", "-c", command], wrapped: false }` — a transparent
 *   passthrough with no behavioural change (documented no-op seam).
 */
export function wrapCommand(
  command: string,
  policy: SandboxPolicy,
  platform?: NodeJS.Platform,
): WrapResult {
  if (sandboxAvailable(platform)) {
    const profile = seatbeltProfile(policy);
    return {
      argv: ["sandbox-exec", "-p", profile, "sh", "-c", command],
      wrapped: true,
    };
  }

  return {
    argv: ["sh", "-c", command],
    wrapped: false,
  };
}

/**
 * Build a conservative default `SandboxPolicy` for `workingDir`.
 *
 * Writable paths: the working directory and `/tmp`.
 * Network: denied.
 */
export function defaultPolicy(workingDir: string): SandboxPolicy {
  return {
    writablePaths: [workingDir, "/tmp"],
    allowNetwork: false,
  };
}
