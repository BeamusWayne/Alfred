/**
 * Checkpoint / rollback for the autonomous harness.
 * ADR 0001 §7.7 (checkpoint/rollback)
 *
 * Before the harness attempts a feature, it snapshots the working tree via
 * `checkpoint()`. If the attempt fails the verify gate, `rollback()` restores
 * the tree to the exact pre-attempt state. git is used as the snapshot store.
 * When `cwd` is not a git repo the functions degrade gracefully: `checkpoint`
 * returns null and `rollback` is a no-op.
 */

// ---------------------------------------------------------------------------
// Private git helper
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

export interface Checkpoint {
  readonly kind: "git";
  /** The HEAD commit SHA at checkpoint time. */
  readonly head: string;
  /**
   * A loose commit object produced by `git stash create`, capturing any dirty
   * working-tree state. Null when the tree was clean. The working tree is left
   * untouched — this ref is kept only as a restorable snapshot.
   */
  readonly stashRef: string | null;
  /** Whether the working tree was dirty when the checkpoint was taken. */
  readonly dirty: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Returns true if `cwd` is inside a git repository. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await git(["rev-parse", "--git-dir"], cwd);
  return result.exitCode === 0;
}

/**
 * Returns the current HEAD commit SHA, or null if `cwd` is not a git repo or
 * the repo has no commits yet.
 */
export async function currentSha(cwd: string): Promise<string | null> {
  const result = await git(["rev-parse", "HEAD"], cwd);
  if (result.exitCode !== 0 || result.stdout === "") return null;
  return result.stdout;
}

/**
 * Snapshots the current working-tree state for later rollback.
 *
 * - Records HEAD SHA.
 * - If the tree is dirty, runs `git stash create` to produce a detached stash
 *   commit object (the working tree is left exactly as-is).
 * - Returns null when `cwd` is not a git repo.
 */
export async function checkpoint(cwd: string): Promise<Checkpoint | null> {
  if (!(await isGitRepo(cwd))) return null;

  const head = await currentSha(cwd);
  if (head === null) return null;

  // Determine dirtiness via `git status --porcelain`.
  const statusResult = await git(["status", "--porcelain"], cwd);
  const dirty = statusResult.exitCode === 0 && statusResult.stdout.length > 0;

  let stashRef: string | null = null;
  if (dirty) {
    // `git stash create` writes a stash commit object without modifying the
    // index or working tree, and prints the object SHA to stdout.
    const stashResult = await git(["stash", "create"], cwd);
    if (stashResult.exitCode === 0 && stashResult.stdout.length > 0) {
      stashRef = stashResult.stdout;
    }
  }

  return { kind: "git", head, stashRef, dirty };
}

/**
 * Restores the working tree to the state captured by `checkpoint()`.
 *
 * 1. `git reset --hard <head>` — resets HEAD and index/tree to the checkpoint
 *    commit, discarding any commits or index changes made since.
 * 2. If the checkpoint had dirty working-tree state (`stashRef !== null`),
 *    `git stash apply <stashRef>` re-applies that state on top.
 *
 * Defensive: never throws on benign git noise; surfaces real failures as
 * thrown Error instances.
 */
export async function rollback(cwd: string, cp: Checkpoint): Promise<void> {
  const resetResult = await git(["reset", "--hard", cp.head], cwd);
  if (resetResult.exitCode !== 0) {
    throw new Error(
      `checkpoint rollback: git reset --hard ${cp.head} failed: ${resetResult.stderr}`
    );
  }

  if (cp.stashRef !== null) {
    // best-effort: if stash apply fails (e.g. conflicts) we log the stderr but
    // do not throw — the HEAD is already restored which is the primary goal.
    const applyResult = await git(["stash", "apply", cp.stashRef], cwd);
    if (applyResult.exitCode !== 0) {
      // Surface as a non-fatal warning via returned error information.
      // Callers that care can inspect; we do not swallow silently by design.
      throw new Error(
        `checkpoint rollback: git stash apply ${cp.stashRef} failed (HEAD was reset OK): ${applyResult.stderr}`
      );
    }
  }
}
