import { test, expect, describe } from "bun:test";
import { buildSystemPrompt, type SystemContext } from "../src/context/index.ts";

function ctx(over: Partial<SystemContext> = {}): SystemContext {
  return { workingDir: "/w", date: "2026-06-05", git: null, projectDocs: [], ...over };
}

describe("buildSystemPrompt", () => {
  test("includes identity, tool policy, and safety", () => {
    const p = buildSystemPrompt(ctx());
    expect(p).toContain("You are Alfred");
    expect(p).toContain("file_read");
    expect(p).toContain("NEVER run destructive");
  });

  test("includes the working directory and date", () => {
    const p = buildSystemPrompt(ctx());
    expect(p).toContain("Working directory: /w");
    expect(p).toContain("Today: 2026-06-05");
  });

  test("injects project docs as fenced guidance", () => {
    const p = buildSystemPrompt(ctx({ projectDocs: [{ path: "/w/AGENTS.md", content: "always run tests" }] }));
    expect(p).toContain("Project instructions");
    expect(p).toContain("always run tests");
    expect(p).toContain('path="/w/AGENTS.md"');
  });

  test("includes git context when present", () => {
    const p = buildSystemPrompt(ctx({ git: { branch: "main", status: "" } }));
    expect(p).toContain("Git branch: main");
  });

  test("keeps the volatile environment after the stable prefix (cache-friendly)", () => {
    const p = buildSystemPrompt(ctx());
    expect(p.indexOf("You are Alfred")).toBeLessThan(p.indexOf("Working directory"));
  });
});
