import { test, expect, describe } from "bun:test";
import { locate } from "../src/tools/lib/seekSequence.ts";

describe("locate", () => {
  test("exact match returns the span", () => {
    const hay = "const a = 1;\nconst b = 2;\n";
    const got = locate(hay, "const b = 2;");
    expect(got?.strategy).toBe("exact");
    expect(got?.count).toBe(1);
    expect(hay.slice(got!.start, got!.end)).toBe("const b = 2;");
  });

  test("tolerates trailing-whitespace drift (rstrip)", () => {
    // needle carries trailing spaces the file line lacks → exact fails, rstrip wins
    const hay = "function f() {\n  return 1;\n}\n";
    const got = locate(hay, "  return 1;   ");
    expect(got).not.toBeNull();
    expect(got?.strategy).toBe("rstrip");
    expect(hay.slice(got!.start, got!.end)).toBe("  return 1;");
  });

  test("tolerates indentation drift (trim)", () => {
    // file uses a tab, needle uses spaces → exact fails, trim wins
    const hay = "function f() {\n\tfoo();\n}\n";
    const got = locate(hay, "  foo();");
    expect(got?.strategy).toBe("trim");
  });

  test("reports ambiguity via count > 1", () => {
    const hay = "x = 1;\nx = 1;\n";
    const got = locate(hay, "x = 1;");
    expect(got?.count).toBe(2);
  });

  test("returns null when not found", () => {
    expect(locate("abc", "zzz")).toBeNull();
  });

  test("returns null for empty needle", () => {
    expect(locate("abc", "")).toBeNull();
  });
});
