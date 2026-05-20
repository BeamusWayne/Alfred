import { describe, test, expect, beforeEach } from "bun:test";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { clearSkills, registerSkill, getSkill, listSkills, type Skill } from "../src/skills/store.js";
import { loadSkillsFromDir } from "../src/skills/loader.js";
import { skillTool } from "../src/tools/skillTool.js";
import { clearCommands, getCommand } from "../src/commands/types.js";

const TMP_DIR = "/tmp/alfred-skills-test";

beforeEach(async () => {
  clearSkills();
  clearCommands();
  await rm(TMP_DIR, { recursive: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

describe("skill store", () => {
  test("register and retrieve a skill", () => {
    const skill: Skill = {
      name: "review",
      description: "Review code for quality issues",
      content: "Review the following code for quality, security, and maintainability:\n\n{{args}}",
    };
    registerSkill(skill);
    expect(getSkill("review")).toEqual(skill);
  });

  test("list all registered skills", () => {
    registerSkill({ name: "review", description: "Code review", content: "Review: {{args}}" });
    registerSkill({ name: "test", description: "Write tests", content: "Write tests for: {{args}}" });
    const skills = listSkills();
    expect(skills).toHaveLength(2);
    expect(skills.map((s) => s.name).sort()).toEqual(["review", "test"]);
  });

  test("get nonexistent skill returns undefined", () => {
    expect(getSkill("nope")).toBeUndefined();
  });

  test("clear skills removes all", () => {
    registerSkill({ name: "a", description: "A", content: "A" });
    clearSkills();
    expect(listSkills()).toHaveLength(0);
  });
});

describe("skill loading from directory", () => {
  test("load skills from markdown files", async () => {
    await writeFile(
      join(TMP_DIR, "review.md"),
      [
        "---",
        "name: review",
        "description: Review code",
        "---",
        "Review the following code:\n\n{{args}}",
      ].join("\n"),
    );

    const loaded = await loadSkillsFromDir(TMP_DIR);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe("review");
    expect(loaded[0].description).toBe("Review code");
    expect(loaded[0].content).toContain("{{args}}");
  });

  test("skip files without frontmatter", async () => {
    await writeFile(join(TMP_DIR, "notes.md"), "Just some notes, not a skill.");
    const loaded = await loadSkillsFromDir(TMP_DIR);
    expect(loaded).toHaveLength(0);
  });

  test("infer name from filename if missing from frontmatter", async () => {
    await writeFile(
      join(TMP_DIR, "my-skill.md"),
      [
        "---",
        "description: A custom skill",
        "---",
        "Do something useful.",
      ].join("\n"),
    );
    const loaded = await loadSkillsFromDir(TMP_DIR);
    expect(loaded[0].name).toBe("my-skill");
  });

  test("skip files missing both name and description", async () => {
    await writeFile(
      join(TMP_DIR, "empty.md"),
      ["---", "---", "No name or description."].join("\n"),
    );
    const loaded = await loadSkillsFromDir(TMP_DIR);
    expect(loaded).toHaveLength(0);
  });

  test("load multiple skills", async () => {
    await writeFile(
      join(TMP_DIR, "a.md"),
      ["---", "name: skill-a", "description: Skill A", "---", "Content A"].join("\n"),
    );
    await writeFile(
      join(TMP_DIR, "b.md"),
      ["---", "name: skill-b", "description: Skill B", "---", "Content B"].join("\n"),
    );
    const loaded = await loadSkillsFromDir(TMP_DIR);
    expect(loaded).toHaveLength(2);
  });

  test("nonexistent directory returns empty", async () => {
    const loaded = await loadSkillsFromDir("/tmp/no-such-dir-skills");
    expect(loaded).toEqual([]);
  });
});

describe("skillTool", () => {
  const context = {
    abortController: new AbortController(),
    workingDir: "/tmp",
    readFileState: new Map(),
    permissionContext: {
      mode: "bypass" as const,
      allowedTools: new Set(),
      deniedTools: new Set(),
      workingDir: "/tmp",
    },
  };

  test("execute a registered skill", async () => {
    registerSkill({
      name: "greet",
      description: "Greet someone",
      content: "Say hello to {{args}} and wish them well.",
    });
    const result = await skillTool.call({ name: "greet", args: "Alice" }, context);
    expect(result.content).toContain("Say hello to Alice");
  });

  test("execute skill with no args", async () => {
    registerSkill({
      name: "status",
      description: "Show status",
      content: "Current project status is good.",
    });
    const result = await skillTool.call({ name: "status", args: "" }, context);
    expect(result.content).toContain("Current project status is good");
  });

  test("error on unknown skill", async () => {
    const result = await skillTool.call({ name: "nope", args: "" }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });
});

describe("skill registers as slash command", () => {
  test("loaded skill becomes a command", async () => {
    await writeFile(
      join(TMP_DIR, "review.md"),
      [
        "---",
        "name: review",
        "description: Review code",
        "---",
        "Review the code: {{args}}",
      ].join("\n"),
    );

    await loadSkillsFromDir(TMP_DIR, { registerAsCommands: true });
    const cmd = getCommand("review");
    expect(cmd).toBeDefined();
    expect(cmd!.description).toBe("Review code");

    const result = await cmd!.execute("src/index.ts");
    expect(result.type).toBe("text");
    expect(result.content).toContain("Review the code: src/index.ts");
  });
});
