/**
 * Tests for src/harness/checkpoint.ts
 * ADR 0001 §7.7 (checkpoint/rollback)
 *
 * Each test case creates a throwaway git repo under tmpdir() and removes it
 * on cleanup — the real project repo is never touched.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import {
  isGitRepo,
  currentSha,
  checkpoint,
  rollback,
} from "../src/harness/checkpoint.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function spawn(
  args: readonly string[],
  cwd: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

/** Initialise a fresh git repo with a single commit. Returns the repo root. */
async function makeRepo(base: string): Promise<string> {
  const dir = await mkdtemp(join(base, "alfred-cp-"));
  await spawn(["git", "init"], dir);
  await spawn(["git", "config", "user.email", "test@alfred.local"], dir);
  await spawn(["git", "config", "user.name", "Alfred Test"], dir);
  // Initial commit so HEAD exists.
  await writeFile(join(dir, "README.md"), "initial\n");
  await spawn(["git", "add", "."], dir);
  await spawn(["git", "commit", "-m", "init"], dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Fixture state
// ---------------------------------------------------------------------------

let tmpBase: string;
let repoDir: string;

beforeEach(async () => {
  tmpBase = await mkdtemp(join(tmpdir(), "alfred-test-"));
  repoDir = await makeRepo(tmpBase);
});

afterEach(async () => {
  await rm(tmpBase, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// isGitRepo
// ---------------------------------------------------------------------------

describe("isGitRepo", () => {
  test("returns true for a git repo", async () => {
    expect(await isGitRepo(repoDir)).toBe(true);
  });

  test("returns false for a plain temp directory", async () => {
    const plain = await mkdtemp(join(tmpBase, "plain-"));
    expect(await isGitRepo(plain)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// currentSha
// ---------------------------------------------------------------------------

describe("currentSha", () => {
  test("returns a 40-char hex SHA for a repo with commits", async () => {
    const sha = await currentSha(repoDir);
    expect(sha).not.toBeNull();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("returns null for a non-repo directory", async () => {
    const plain = await mkdtemp(join(tmpBase, "plain-"));
    expect(await currentSha(plain)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkpoint + rollback (clean tree)
// ---------------------------------------------------------------------------

describe("checkpoint on a clean tree", () => {
  test("records HEAD and dirty=false with no stashRef", async () => {
    const cp = await checkpoint(repoDir);
    expect(cp).not.toBeNull();
    expect(cp!.kind).toBe("git");
    expect(cp!.dirty).toBe(false);
    expect(cp!.stashRef).toBeNull();
    expect(cp!.head).toMatch(/^[0-9a-f]{40}$/);
  });
});

// ---------------------------------------------------------------------------
// checkpoint + rollback (dirty tree — modified tracked file)
// ---------------------------------------------------------------------------

describe("checkpoint on a dirty tree", () => {
  test("records dirty=true and a non-null stashRef", async () => {
    await writeFile(join(repoDir, "README.md"), "modified\n");
    const cp = await checkpoint(repoDir);
    expect(cp).not.toBeNull();
    expect(cp!.dirty).toBe(true);
    expect(cp!.stashRef).not.toBeNull();
  });

  test("rollback restores the file to pre-checkpoint content", async () => {
    // Content before checkpoint.
    const original = await readFile(join(repoDir, "README.md"), "utf8");

    const cp = await checkpoint(repoDir);
    expect(cp).not.toBeNull();

    // Simulate the agent making changes after the checkpoint.
    await writeFile(join(repoDir, "README.md"), "agent-modified\n");
    // Also add a new commit on top.
    await spawn(["git", "add", "."], repoDir);
    await spawn(["git", "commit", "-m", "agent work"], repoDir);

    // Roll back.
    await rollback(repoDir, cp!);

    // HEAD should be reset to the checkpoint SHA.
    const sha = await currentSha(repoDir);
    expect(sha).toBe(cp!.head);

    // The working-tree file should be back to its dirty (pre-checkpoint) state,
    // which stash apply restores.
    const content = await readFile(join(repoDir, "README.md"), "utf8");
    expect(content).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// checkpoint + rollback (new commit after checkpoint, clean tree)
// ---------------------------------------------------------------------------

describe("rollback after extra commit on clean tree", () => {
  test("resets HEAD to checkpoint SHA", async () => {
    const cp = await checkpoint(repoDir);
    expect(cp).not.toBeNull();

    // Make a new commit after the checkpoint.
    await writeFile(join(repoDir, "new.txt"), "extra\n");
    await spawn(["git", "add", "."], repoDir);
    await spawn(["git", "commit", "-m", "extra work"], repoDir);

    const shaAfter = await currentSha(repoDir);
    expect(shaAfter).not.toBe(cp!.head);

    await rollback(repoDir, cp!);

    const shaRestored = await currentSha(repoDir);
    expect(shaRestored).toBe(cp!.head);
  });
});

// ---------------------------------------------------------------------------
// checkpoint returns null outside a git repo
// ---------------------------------------------------------------------------

describe("checkpoint outside a git repo", () => {
  test("returns null for a plain directory", async () => {
    const plain = await mkdtemp(join(tmpBase, "plain-"));
    const cp = await checkpoint(plain);
    expect(cp).toBeNull();
  });
});

describe("rollback — untracked file handling", () => {
  test("removes untracked files the attempt created but preserves pre-existing ones", async () => {
    // An untracked file present BEFORE the checkpoint must survive rollback.
    await writeFile(join(repoDir, "preexisting.txt"), "keep me\n");
    const cp = await checkpoint(repoDir);
    expect(cp).not.toBeNull();

    // The attempt creates a new untracked file and modifies a tracked one.
    await writeFile(join(repoDir, "attempt_new.ts"), "export const x = 1;\n");
    await writeFile(join(repoDir, "README.md"), "changed by attempt\n");

    await rollback(repoDir, cp!);

    // New untracked removed; pre-existing untracked kept; tracked change reverted.
    expect(await Bun.file(join(repoDir, "attempt_new.ts")).exists()).toBe(false);
    expect(await Bun.file(join(repoDir, "preexisting.txt")).exists()).toBe(true);
    expect((await readFile(join(repoDir, "README.md"), "utf8")).trim()).toBe("initial");
  });
});
