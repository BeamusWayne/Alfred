/**
 * Worktree-isolated best-of-N for code variants.
 * ADR 0001 §5.3 (best-of-N, objective reward) — worktree-isolated code variant.
 *
 * The general `bestOfN` primitive scores structured LLM candidates. This variant
 * instead runs N code-writing attempts in fully isolated git worktrees so they
 * cannot clobber each other. It then selects the first candidate (lowest index)
 * whose objective verify gate exits 0 — honest, machine-enforced inference-time
 * scaling.
 *
 * Concurrency: v1 runs candidates **sequentially** (i=0 first) and short-circuits
 * at the first passing candidate. This matches the "first passing" selection rule
 * and keeps the implementation simple. Parallel fan-out can be layered on later
 * by running all N worktrees concurrently and racing on the verify gate; that
 * optimisation is deferred until the sequential baseline is validated.
 *
 * Cleanup: every worktree is removed in a `finally` block — the main repo is
 * always left with a clean worktree list regardless of errors.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { runVerify, passed } from "../../harness/verify.ts";
import { resolveInside, PathEscapeError } from "../../tools/lib/paths.ts";

/**
 * Copy one worktree file into `cwd`, refusing to read through a symlink that
 * escapes the worktree (out-of-tree disclosure) or write through a symlink that
 * escapes `cwd` (clobbering a host file). resolveInside resolves real paths, so
 * a symlink pointing outside throws and the file is skipped rather than copied.
 * Returns true if copied, false if skipped for containment.
 */
async function copyContained(
  worktreePath: string,
  cwd: string,
  relativePath: string,
): Promise<boolean> {
  let src: string;
  let dst: string;
  try {
    src = resolveInside(worktreePath, relativePath);
    dst = resolveInside(cwd, relativePath);
  } catch (err) {
    if (err instanceof PathEscapeError) return false;
    throw err;
  }
  const content = await Bun.file(src).arrayBuffer();
  await Bun.write(dst, content);
  return true;
}

// ---------------------------------------------------------------------------
// Private git helper (mirrors checkpoint.ts §private git helper)
// ---------------------------------------------------------------------------

interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

async function git(args: readonly string[], cwd: string): Promise<GitResult> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { stdout: "", stderr: msg, exitCode: 1 };
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BestOfNCodeOptions {
  /** Path to the git repository root (must be inside a git repo). */
  readonly cwd: string;
  /** Number of candidate attempts to run (≥ 1). */
  readonly n: number;
  /** Shell command that acts as the objective verify gate; exit 0 = pass. */
  readonly verifyCmd: string;
  /** Optional timeout for each verify invocation in milliseconds. */
  readonly verifyTimeoutMs?: number;
  /**
   * Caller-supplied thunk that writes code into `worktreePath` for candidate
   * index `candidate` (0-based). The thunk may do anything within that
   * directory — call an agent, copy files, run `sed`, etc. It must NOT touch
   * `opts.cwd` or any other worktree.
   */
  readonly implement: (worktreePath: string, candidate: number) => Promise<void>;
  /**
   * The git ref to base each worktree on (default: HEAD at call time).
   * Accepts any git-resolvable ref: branch name, tag, or full SHA.
   */
  readonly baseRef?: string;
}

export interface CandidateOutcome {
  /** 0-based candidate index. */
  readonly candidate: number;
  /** Absolute path to the (already-removed) worktree — useful for logging. */
  readonly worktreePath: string;
  /** Exit code returned by the verify command (or 1 on timeout/error). */
  readonly exitCode: number;
  /** True iff exitCode === 0 and the verify command did not time out. */
  readonly passed: boolean;
}

export interface BestOfNCodeResult {
  /**
   * 0-based index of the first passing candidate, or null when all failed.
   * When a winner exists its changes have already been applied to `opts.cwd`.
   */
  readonly winner: number | null;
  /** One entry per candidate, in order. */
  readonly outcomes: readonly CandidateOutcome[];
}

// ---------------------------------------------------------------------------
// applyWinner — exported for unit testing
// ---------------------------------------------------------------------------

/**
 * Apply all changes present in `worktreePath` (relative to `baseRef`) into
 * `cwd`.  Handles two categories:
 *
 *  A) Tracked changes (committed in the worktree): enumerated with
 *     `git diff <baseRef> HEAD --name-only`, then each file is copied
 *     directly from the worktree to `cwd`.  Direct copy avoids the stdin-pipe
 *     brittleness of `git apply -` and is binary-safe.
 *
 *  B) Untracked files (written but not staged/committed): enumerated with
 *     `git ls-files --others --exclude-standard`, then copied directly.
 *
 * This covers the primary use case — `implement` thunks that write files
 * (with or without committing) — without requiring a staging worktree or a
 * temp-file patch.
 *
 * Throws on hard failures; callers surface errors as appropriate.
 */
export async function applyWinner(
  cwd: string,
  worktreePath: string,
  baseRef: string,
): Promise<void> {
  // ── A: tracked changes (committed in the worktree) ─────────────────────
  const diffNamesResult = await git(["diff", baseRef, "HEAD", "--name-only"], worktreePath);
  if (diffNamesResult.exitCode !== 0) {
    throw new Error(
      `applyWinner: git diff --name-only ${baseRef} HEAD failed in worktree: ${diffNamesResult.stderr}`,
    );
  }

  const trackedChanged = diffNamesResult.stdout
    .split("\n")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  for (const relativePath of trackedChanged) {
    await copyContained(worktreePath, cwd, relativePath);
  }

  // ── B: untracked files (not staged/committed yet in worktree) ──────────
  const lsFilesResult = await git(["ls-files", "--others", "--exclude-standard"], worktreePath);
  if (lsFilesResult.exitCode !== 0) {
    throw new Error(
      `applyWinner: git ls-files --others failed in worktree: ${lsFilesResult.stderr}`,
    );
  }

  const untrackedPaths = lsFilesResult.stdout
    .split("\n")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  for (const relativePath of untrackedPaths) {
    await copyContained(worktreePath, cwd, relativePath);
  }
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Run up to `opts.n` code-writing attempts in isolated git worktrees, verify
 * each with `opts.verifyCmd`, and merge the first passing candidate back into
 * `opts.cwd`.
 *
 * The function is sequential in v1: candidates are attempted in order 0, 1, …
 * and the loop stops at the first pass (short-circuit). All worktrees are
 * cleaned up in a `finally` block.
 */
export async function bestOfNCode(opts: BestOfNCodeOptions): Promise<BestOfNCodeResult> {
  const { cwd, n, verifyCmd, verifyTimeoutMs, implement, baseRef: baseRefOpt } = opts;

  // ── Precondition: must be inside a git repo ──────────────────────────────
  const revParseResult = await git(["rev-parse", "--git-dir"], cwd);
  if (revParseResult.exitCode !== 0) {
    throw new Error(
      `bestOfNCode: ${cwd} is not inside a git repository (git rev-parse --git-dir failed)`,
    );
  }

  // Resolve the base ref once so all worktrees branch from the same commit.
  const resolvedBaseRef: string = (() => {
    if (baseRefOpt !== undefined && baseRefOpt.length > 0) return baseRefOpt;
    return "HEAD";
  })();

  // Verify the ref resolves cleanly.
  const refCheckResult = await git(["rev-parse", "--verify", resolvedBaseRef], cwd);
  if (refCheckResult.exitCode !== 0) {
    throw new Error(
      `bestOfNCode: cannot resolve baseRef "${resolvedBaseRef}": ${refCheckResult.stderr}`,
    );
  }
  const resolvedSha = refCheckResult.stdout;

  // Track which worktree paths we created so we can clean them up.
  const worktreePaths: string[] = [];
  const outcomes: CandidateOutcome[] = [];

  try {
    for (let i = 0; i < n; i++) {
      // ── Create an isolated worktree ───────────────────────────────────────
      const tmpBase = await mkdtemp(join(tmpdir(), "alfred-bon-"));
      const worktreePath = join(tmpBase, "worktree");
      worktreePaths.push(worktreePath);

      const addResult = await git(["worktree", "add", "--detach", worktreePath, resolvedSha], cwd);
      if (addResult.exitCode !== 0) {
        throw new Error(
          `bestOfNCode: git worktree add failed for candidate ${i}: ${addResult.stderr}`,
        );
      }

      // ── Let the caller write code into the worktree ───────────────────────
      await implement(worktreePath, i);

      // ── Run the objective verify gate ─────────────────────────────────────
      const verifyResult = await runVerify(verifyCmd, {
        cwd: worktreePath,
        timeoutMs: verifyTimeoutMs,
      });

      const outcome: CandidateOutcome = {
        candidate: i,
        worktreePath,
        exitCode: verifyResult.exitCode,
        passed: passed(verifyResult),
      };
      outcomes.push(outcome);

      if (outcome.passed) {
        // ── Merge the winner back into the main working tree ─────────────────
        await applyWinner(cwd, worktreePath, resolvedSha);

        return {
          winner: i,
          outcomes: outcomes as readonly CandidateOutcome[],
        };
      }
    }

    // All candidates failed.
    return { winner: null, outcomes: outcomes as readonly CandidateOutcome[] };
  } finally {
    // ── Always clean up every worktree ────────────────────────────────────
    for (const wt of worktreePaths) {
      // --force because the worktree may have uncommitted changes.
      await git(["worktree", "remove", "--force", wt], cwd).catch(() => {
        // Ignore errors during cleanup; the worktree directory may already be
        // gone (e.g. if `git worktree add` partially failed and left nothing).
      });
    }
  }
}
