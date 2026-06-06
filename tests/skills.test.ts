/**
 * Tests for the 3-level skills (procedural memory) system.
 *
 * Each test group uses an isolated temp dir so the suite is hermetic — no
 * writes to the repo or a real .alfred/skills/ directory.  Temp dirs are
 * removed in afterEach.
 *
 * ADR 0001 §7.6 (3-level skills = procedural memory, progressive disclosure).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { discoverSkills, loadSkill, renderSkillIndex } from "../src/skills/loader.ts";
import { makeSkillTool } from "../src/skills/skillTool.ts";
import type { SkillMeta } from "../src/skills/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueDir(): string {
  return join(tmpdir(), `alfred-skills-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

let tempRoot = "";

/**
 * Write a SKILL.md into `<root>/<skillName>/SKILL.md` with the given
 * frontmatter values and body text.
 */
async function writeSkillFile(
  root: string,
  skillName: string,
  opts: { name?: string; description?: string; body?: string; raw?: string },
): Promise<void> {
  const dir = join(root, skillName);
  await mkdir(dir, { recursive: true });
  const content =
    opts.raw ??
    `---\nname: ${opts.name ?? skillName}\ndescription: ${opts.description ?? "A test skill."}\n---\n\n${opts.body ?? "Skill body content."}`;
  await writeFile(join(dir, "SKILL.md"), content, "utf-8");
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  }
});

// ---------------------------------------------------------------------------
// discoverSkills
// ---------------------------------------------------------------------------

describe("discoverSkills", () => {
  test("returns empty array when skillsDir does not exist", async () => {
    const result = await discoverSkills("/nonexistent/path/that/cannot/exist");
    expect(result).toEqual([]);
  });

  test("returns empty array for an empty directory", async () => {
    tempRoot = uniqueDir();
    await mkdir(tempRoot, { recursive: true });
    const result = await discoverSkills(tempRoot);
    expect(result).toEqual([]);
  });

  test("discovers two valid skills and returns their metadata", async () => {
    tempRoot = uniqueDir();
    await writeSkillFile(tempRoot, "lint", {
      name: "lint",
      description: "Run the project linter.",
      body: "Step 1: run eslint.",
    });
    await writeSkillFile(tempRoot, "deploy", {
      name: "deploy",
      description: "Deploy to production.",
      body: "Step 1: push to main.",
    });

    const metas = await discoverSkills(tempRoot);
    expect(metas).toHaveLength(2);

    const names = metas.map((m) => m.name).sort();
    expect(names).toEqual(["deploy", "lint"]);

    for (const m of metas) {
      expect(m.path).toContain("SKILL.md");
      expect(m.description).toBeTruthy();
    }
  });

  test("skips a malformed skill (missing description) alongside valid ones", async () => {
    tempRoot = uniqueDir();
    await writeSkillFile(tempRoot, "good-skill", {
      name: "good-skill",
      description: "Does something useful.",
      body: "Good body.",
    });
    // Malformed: missing `description` field
    await writeSkillFile(tempRoot, "bad-skill", {
      raw: "---\nname: bad-skill\n---\n\nNo description.",
    });
    // Another malformed: no frontmatter at all
    await writeSkillFile(tempRoot, "no-frontmatter", {
      raw: "Just plain text with no frontmatter.",
    });

    const metas = await discoverSkills(tempRoot);
    expect(metas).toHaveLength(1);
    expect(metas[0]!.name).toBe("good-skill");
  });

  test("skips subdirectories that have no SKILL.md", async () => {
    tempRoot = uniqueDir();
    // A valid skill
    await writeSkillFile(tempRoot, "valid", {
      name: "valid",
      description: "Valid skill.",
      body: "Valid body.",
    });
    // A directory with no SKILL.md
    await mkdir(join(tempRoot, "empty-dir"), { recursive: true });

    const metas = await discoverSkills(tempRoot);
    expect(metas).toHaveLength(1);
    expect(metas[0]!.name).toBe("valid");
  });

  test("returned SkillMeta has correct path pointing to SKILL.md", async () => {
    tempRoot = uniqueDir();
    await writeSkillFile(tempRoot, "pathcheck", {
      name: "pathcheck",
      description: "Check the path.",
      body: "Body here.",
    });

    const metas = await discoverSkills(tempRoot);
    expect(metas).toHaveLength(1);
    expect(metas[0]!.path).toBe(join(tempRoot, "pathcheck", "SKILL.md"));
  });
});

// ---------------------------------------------------------------------------
// loadSkill
// ---------------------------------------------------------------------------

describe("loadSkill", () => {
  test("returns null for a non-existent skill name", async () => {
    tempRoot = uniqueDir();
    await mkdir(tempRoot, { recursive: true });
    const result = await loadSkill(tempRoot, "ghost");
    expect(result).toBeNull();
  });

  test("returns null when skillsDir does not exist", async () => {
    const result = await loadSkill("/nonexistent/skills", "anything");
    expect(result).toBeNull();
  });

  test("returns Skill with meta and body for a valid skill", async () => {
    tempRoot = uniqueDir();
    await writeSkillFile(tempRoot, "test-skill", {
      name: "test-skill",
      description: "A well-formed test skill.",
      body: "## Instructions\n\nDo the thing.\n",
    });

    const skill = await loadSkill(tempRoot, "test-skill");
    expect(skill).not.toBeNull();
    expect(skill!.meta.name).toBe("test-skill");
    expect(skill!.meta.description).toBe("A well-formed test skill.");
    expect(skill!.meta.path).toBe(join(tempRoot, "test-skill", "SKILL.md"));
    expect(skill!.body).toContain("## Instructions");
    expect(skill!.body).toContain("Do the thing.");
  });

  test("returns null for a malformed SKILL.md (invalid frontmatter)", async () => {
    tempRoot = uniqueDir();
    await writeSkillFile(tempRoot, "broken", {
      raw: "---\nname: broken\n---\n\nNo description in frontmatter.",
    });

    const result = await loadSkill(tempRoot, "broken");
    expect(result).toBeNull();
  });

  test("body does not include frontmatter delimiters", async () => {
    tempRoot = uniqueDir();
    await writeSkillFile(tempRoot, "clean", {
      name: "clean",
      description: "Verify body is clean.",
      body: "This is the real body.",
    });

    const skill = await loadSkill(tempRoot, "clean");
    expect(skill).not.toBeNull();
    expect(skill!.body).not.toContain("---");
    expect(skill!.body).not.toContain("name: clean");
    expect(skill!.body).toContain("This is the real body.");
  });
});

// ---------------------------------------------------------------------------
// renderSkillIndex
// ---------------------------------------------------------------------------

describe("renderSkillIndex", () => {
  test("renders a header + empty note when metas list is empty", () => {
    const output = renderSkillIndex([]);
    expect(output).toContain("## Available skills");
    expect(output).toContain("No skills available");
  });

  test("renders each skill as name — description", () => {
    const metas: readonly SkillMeta[] = [
      { name: "lint", description: "Run the linter.", path: "/a/lint/SKILL.md" },
      { name: "deploy", description: "Deploy to prod.", path: "/a/deploy/SKILL.md" },
    ];
    const output = renderSkillIndex(metas);
    expect(output).toContain("## Available skills");
    expect(output).toContain("lint");
    expect(output).toContain("Run the linter.");
    expect(output).toContain("deploy");
    expect(output).toContain("Deploy to prod.");
  });

  test("output contains both skills from discoverSkills", async () => {
    tempRoot = uniqueDir();
    await writeSkillFile(tempRoot, "skill-a", {
      name: "skill-a",
      description: "First skill.",
      body: "Body A.",
    });
    await writeSkillFile(tempRoot, "skill-b", {
      name: "skill-b",
      description: "Second skill.",
      body: "Body B.",
    });

    const metas = await discoverSkills(tempRoot);
    const output = renderSkillIndex(metas);

    expect(output).toContain("skill-a");
    expect(output).toContain("First skill.");
    expect(output).toContain("skill-b");
    expect(output).toContain("Second skill.");
  });
});

// ---------------------------------------------------------------------------
// makeSkillTool (load_skill)
// ---------------------------------------------------------------------------

describe("makeSkillTool (load_skill)", () => {
  const fakeCtx = {
    workingDir: "/tmp",
    signal: new AbortController().signal,
    readFileState: new Map(),
    permissions: {
      mode: "default" as const,
      allowedTools: new Set<string>(),
      deniedTools: new Set<string>(),
      workingDir: "/tmp",
    },
  };

  test("tool has name 'load_skill' and is read-only and concurrency-safe", () => {
    const tool = makeSkillTool("/any/path");
    expect(tool.name).toBe("load_skill");
    expect(tool.isReadOnly({ name: "x" })).toBe(true);
    expect(tool.isConcurrencySafe({ name: "x" })).toBe(true);
  });

  test("checkPermissions returns allow", async () => {
    const tool = makeSkillTool("/any/path");
    const result = await tool.checkPermissions({ name: "x" }, fakeCtx.permissions);
    expect(result.behavior).toBe("allow");
  });

  test("call returns skill body for a valid skill name", async () => {
    tempRoot = uniqueDir();
    await writeSkillFile(tempRoot, "greet", {
      name: "greet",
      description: "Greeting skill.",
      body: "Say hello to the user.",
    });

    const tool = makeSkillTool(tempRoot);
    const result = await tool.call({ name: "greet" }, fakeCtx);

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Say hello to the user.");
  });

  test("call returns an error result for an unknown skill name", async () => {
    tempRoot = uniqueDir();
    await mkdir(tempRoot, { recursive: true });

    const tool = makeSkillTool(tempRoot);
    const result = await tool.call({ name: "nonexistent" }, fakeCtx);

    expect(result.isError).toBe(true);
    expect(typeof result.content).toBe("string");
    expect((result.content as string)).toContain("nonexistent");
  });

  test("describeCall formats the name correctly", () => {
    const tool = makeSkillTool("/any/path");
    expect(tool.describeCall({ name: "deploy" })).toBe("load_skill(deploy)");
  });

  test("isEnabled returns true by default", () => {
    const tool = makeSkillTool("/any/path");
    expect(tool.isEnabled()).toBe(true);
  });
});
