import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { discoverClaudeMds, formatClaudeMds } from "../src/context/claudemd.js";
import { buildSystemContext, buildSystemPrompt } from "../src/context/index.js";

let testDir: string;

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), "alfred-ctx-"));
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("CLAUDE.md discovery", () => {
  test("finds CLAUDE.md in working directory", () => {
    writeFileSync(join(testDir, "CLAUDE.md"), "# Project instructions\nBe helpful.");
    const files = discoverClaudeMds(testDir);
    expect(files.some((f) => f.content.includes("Be helpful."))).toBe(true);
  });

  test("finds .claude/CLAUDE.md", () => {
    mkdirSync(join(testDir, ".claude"), { recursive: true });
    writeFileSync(join(testDir, ".claude/CLAUDE.md"), "# Local instructions\nUse TypeScript.");
    const files = discoverClaudeMds(testDir);
    expect(files.some((f) => f.content.includes("Use TypeScript."))).toBe(true);
  });

  test("returns empty array for directory with no CLAUDE.md", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "alfred-empty-"));
    const files = discoverClaudeMds(emptyDir);
    const fromEmptyDir = files.filter((f) => f.filePath.startsWith(emptyDir));
    expect(fromEmptyDir).toHaveLength(0);
    rmSync(emptyDir, { recursive: true, force: true });
  });

  test("formatClaudeMds produces readable output", () => {
    const files = [
      { content: "First file", filePath: "/project/CLAUDE.md" },
      { content: "Second file", filePath: "/project/.claude/CLAUDE.md" },
    ];
    const output = formatClaudeMds(files);
    expect(output).toContain("--- /project/CLAUDE.md ---");
    expect(output).toContain("First file");
  });
});

describe("buildSystemContext", () => {
  test("returns context with currentDate and workingDir", async () => {
    const ctx = await buildSystemContext(testDir);
    expect(ctx.currentDate).toContain("Today's date is");
    expect(ctx.workingDir).toBe(testDir);
  });

  test("detects CLAUDE.md in project", async () => {
    writeFileSync(join(testDir, "CLAUDE.md"), "# Test project\nDo good things.");
    const ctx = await buildSystemContext(testDir);
    expect(ctx.claudeMd).toContain("Do good things.");
  });

  test("gitStatus is null for non-git directory", async () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), "alfred-nongit-"));
    const ctx = await buildSystemContext(nonGitDir);
    expect(ctx.gitStatus).toBeNull();
    rmSync(nonGitDir, { recursive: true, force: true });
  });
});

describe("buildSystemPrompt", () => {
  test("includes working directory", () => {
    const prompt = buildSystemPrompt({
      gitStatus: null,
      claudeMd: null,
      currentDate: "Today's date is 2026-05-18.",
      workingDir: "/home/user/project",
    });
    expect(prompt).toContain("Working directory: /home/user/project");
    expect(prompt).toContain("You are Alfred");
  });

  test("includes CLAUDE.md when present", () => {
    const prompt = buildSystemPrompt({
      gitStatus: null,
      claudeMd: "# Instructions\nAlways write tests.",
      currentDate: "Today's date is 2026-05-18.",
      workingDir: "/project",
    });
    expect(prompt).toContain("## Project Instructions (CLAUDE.md)");
    expect(prompt).toContain("Always write tests.");
  });

  test("includes git context when present", () => {
    const prompt = buildSystemPrompt({
      gitStatus: "Current branch: feature/x\nStatus:\n(clean)",
      claudeMd: null,
      currentDate: "Today's date is 2026-05-18.",
      workingDir: "/project",
    });
    expect(prompt).toContain("## Git Context");
    expect(prompt).toContain("feature/x");
  });

  test("minimal prompt without optional sections", () => {
    const prompt = buildSystemPrompt({
      gitStatus: null,
      claudeMd: null,
      currentDate: "Today's date is 2026-05-18.",
      workingDir: "/tmp",
    });
    expect(prompt).not.toContain("## Git Context");
    expect(prompt).not.toContain("## Project Instructions");
  });
});
