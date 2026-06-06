/**
 * Tests for src/orchestrator/workflows/bestOfNCode.ts.
 * ADR 0001 §5.3 (best-of-N, objective reward) — worktree-isolated code variant.
 *
 * Each test group creates a throwaway git repo under tmpdir() and removes it
 * afterwards — the real project repo is never touched.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { bestOfNCode, applyWinner } from "../src/orchestrator/workflows/bestOfNCode.ts";

// ---------------------------------------------------------------------------
// Git spawn helper (mirrors checkpoint.test.ts)
// ---------------------------------------------------------------------------

async function spawn(
  args: readonly string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

/** Initialise a fresh git repo with one initial commit. Returns the repo root. */
async function makeRepo(base: string): Promise<string> {
  const dir = await mkdtemp(join(base, "alfred-bon-repo-"));
  await spawn(["git", "init"], dir);
  await spawn(["git", "config", "user.email", "test@alfred.local"], dir);
  await spawn(["git", "config", "user.name", "Alfred Test"], dir);
  await writeFile(join(dir, "README.md"), "initial\n");
  await spawn(["git", "add", "."], dir);
  await spawn(["git", "commit", "-m", "init"], dir);
  return dir;
}

/** List active worktrees for `repoDir` (all entries, including main). */
async function listWorktrees(repoDir: string): Promise<string[]> {
  const result = await spawn(["git", "worktree", "list", "--porcelain"], repoDir);
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim());
}

/**
 * Resolve a path through any OS-level symlinks (e.g. /var → /private/var on
 * macOS). Uses `realpath` so comparisons are always against the canonical form.
 */
async function realPath(p: string): Promise<string> {
  const result = await spawn(["realpath", p], "/");
  return result.exitCode === 0 ? result.stdout : p;
}

// ---------------------------------------------------------------------------
// Fixture state
// ---------------------------------------------------------------------------

let tmpBase: string;
let repoDir: string;

beforeEach(async () => {
  tmpBase = await mkdtemp(join(tmpdir(), "alfred-bontest-"));
  repoDir = await makeRepo(tmpBase);
});

afterEach(async () => {
  await rm(tmpBase, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Happy path — candidate 0 fails, candidate 1 passes
// ---------------------------------------------------------------------------

describe("bestOfNCode — first passing candidate wins", () => {
  test(
    "winner === 1 when candidate 0 fails and candidate 1 passes; winner's file present in cwd; all worktrees removed",
    async () => {
      // verifyCmd checks for a sentinel file written by the passing candidate.
      const sentinelFile = "PASSING.txt";
      const verifyCmd = `test -f ${sentinelFile}`;

      const result = await bestOfNCode({
        cwd: repoDir,
        n: 2,
        verifyCmd,
        implement: async (worktreePath, candidate) => {
          if (candidate === 0) {
            // Candidate 0: write a wrong file — verify will fail.
            await writeFile(join(worktreePath, "WRONG.txt"), "bad\n");
          } else {
            // Candidate 1: write the sentinel — verify will pass.
            await writeFile(join(worktreePath, sentinelFile), "good\n");
          }
        },
      });

      // Correct winner.
      expect(result.winner).toBe(1);

      // Both candidates were attempted.
      expect(result.outcomes).toHaveLength(2);

      // Candidate 0 failed; candidate 1 passed.
      expect(result.outcomes[0]?.passed).toBe(false);
      expect(result.outcomes[1]?.passed).toBe(true);

      // The winner's sentinel file must now exist in the main repo.
      const sentinelInCwd = Bun.file(join(repoDir, sentinelFile));
      expect(await sentinelInCwd.exists()).toBe(true);

      // Only the main worktree should remain.
      const worktrees = await listWorktrees(repoDir);
      expect(worktrees).toHaveLength(1);
      // The sole remaining entry is the main repo itself (resolve symlinks for macOS /var → /private/var).
      expect(worktrees[0]).toBe(await realPath(repoDir));
    },
  );
});

// ---------------------------------------------------------------------------
// All-fail — winner is null; cwd unchanged
// ---------------------------------------------------------------------------

describe("bestOfNCode — all candidates fail", () => {
  test(
    "winner is null and cwd is unchanged when every candidate fails",
    async () => {
      const sentinelFile = "MUST_NOT_EXIST.txt";
      const verifyCmd = `test -f ${sentinelFile}`;

      // Capture the initial state of cwd.
      const readmeContentBefore = await Bun.file(join(repoDir, "README.md")).text();

      const result = await bestOfNCode({
        cwd: repoDir,
        n: 3,
        verifyCmd,
        implement: async (worktreePath, candidate) => {
          // All candidates write a file that is NOT the sentinel → verify fails.
          await writeFile(join(worktreePath, `candidate-${candidate}.txt`), "nope\n");
        },
      });

      expect(result.winner).toBeNull();
      expect(result.outcomes).toHaveLength(3);

      for (const outcome of result.outcomes) {
        expect(outcome.passed).toBe(false);
      }

      // The sentinel must not appear in cwd.
      const sentinelInCwd = Bun.file(join(repoDir, sentinelFile));
      expect(await sentinelInCwd.exists()).toBe(false);

      // README.md must be unchanged (no winner merge occurred).
      const readmeContentAfter = await Bun.file(join(repoDir, "README.md")).text();
      expect(readmeContentAfter).toBe(readmeContentBefore);

      // All worktrees cleaned up.
      const worktrees = await listWorktrees(repoDir);
      expect(worktrees).toHaveLength(1);
      expect(worktrees[0]).toBe(await realPath(repoDir));
    },
  );
});

// ---------------------------------------------------------------------------
// Short-circuit — later candidates are never run after the first pass
// ---------------------------------------------------------------------------

describe("bestOfNCode — short-circuit on first pass", () => {
  test("candidate 0 passes; outcomes has length 1 (candidates 1..n-1 not run)", async () => {
    const sentinelFile = "EARLY_WIN.txt";
    const verifyCmd = `test -f ${sentinelFile}`;

    const result = await bestOfNCode({
      cwd: repoDir,
      n: 5,
      verifyCmd,
      implement: async (worktreePath) => {
        // Every candidate writes the sentinel — but we only care that candidate 0
        // passes and the rest are never attempted.
        await writeFile(join(worktreePath, sentinelFile), "win\n");
      },
    });

    expect(result.winner).toBe(0);
    // Only one outcome: the function short-circuited after candidate 0.
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyWinner — unit-testable merge helper
// ---------------------------------------------------------------------------

describe("applyWinner — applies worktree diff to cwd", () => {
  test("a file written and committed in the worktree appears in cwd after apply", async () => {
    // Resolve HEAD sha.
    const headResult = await spawn(["git", "rev-parse", "HEAD"], repoDir);
    const baseSha = headResult.stdout;

    // Create an isolated worktree.
    const worktreeTmp = await mkdtemp(join(tmpBase, "apply-test-wt-"));
    const worktreePath = join(worktreeTmp, "wt");
    await spawn(["git", "worktree", "add", "--detach", worktreePath, baseSha], repoDir);

    try {
      // Write a new file in the worktree and stage+commit it so `git diff` sees it.
      await writeFile(join(worktreePath, "applied.txt"), "applied content\n");
      await spawn(["git", "add", "applied.txt"], worktreePath);
      await spawn(["git", "-c", "user.email=t@t.com", "-c", "user.name=T", "commit", "-m", "add applied"], worktreePath);

      // Apply the worktree's diff back to the main repo.
      await applyWinner(repoDir, worktreePath, baseSha);

      // The file must now exist in the main repo.
      const appliedInCwd = Bun.file(join(repoDir, "applied.txt"));
      expect(await appliedInCwd.exists()).toBe(true);
      expect(await appliedInCwd.text()).toBe("applied content\n");
    } finally {
      await spawn(["git", "worktree", "remove", "--force", worktreePath], repoDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Error path — not a git repo
// ---------------------------------------------------------------------------

describe("bestOfNCode — error when cwd is not a git repo", () => {
  test("throws a clear error when called outside a git repository", async () => {
    const plainDir = await mkdtemp(join(tmpBase, "plain-"));

    await expect(
      bestOfNCode({
        cwd: plainDir,
        n: 1,
        verifyCmd: "true",
        implement: async () => {
          // Never reached.
        },
      }),
    ).rejects.toThrow(/not inside a git repository/);
  });
});

// ---------------------------------------------------------------------------
// outcomes order and index fields are correct
// ---------------------------------------------------------------------------

describe("bestOfNCode — outcome metadata", () => {
  test("each outcome records the correct candidate index and worktreePath", async () => {
    // All candidates fail; we just want to inspect the outcome metadata.
    const verifyCmd = "false"; // always fails

    const result = await bestOfNCode({
      cwd: repoDir,
      n: 3,
      verifyCmd,
      implement: async (_worktreePath, _candidate) => {
        // no-op
      },
    });

    expect(result.outcomes).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      const outcome = result.outcomes[i];
      expect(outcome).toBeDefined();
      expect(outcome!.candidate).toBe(i);
      expect(outcome!.exitCode).not.toBe(0);
      expect(outcome!.passed).toBe(false);
      // worktreePath was a real path that has since been cleaned up.
      expect(typeof outcome!.worktreePath).toBe("string");
      expect(outcome!.worktreePath.length).toBeGreaterThan(0);
    }
  });
});
