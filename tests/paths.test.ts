import { test, expect, describe } from "bun:test";
import { resolveInside, isInside, PathEscapeError } from "../src/tools/lib/paths.ts";

describe("resolveInside", () => {
  const root = "/work/project";

  test("resolves a relative path inside root", () => {
    expect(resolveInside(root, "src/a.ts")).toBe("/work/project/src/a.ts");
  });

  test("resolves the root itself", () => {
    expect(resolveInside(root, ".")).toBe("/work/project");
  });

  test("throws when escaping via ..", () => {
    expect(() => resolveInside(root, "../../etc/passwd")).toThrow(PathEscapeError);
  });

  test("throws for an absolute path outside root", () => {
    expect(() => resolveInside(root, "/etc/passwd")).toThrow(PathEscapeError);
  });

  test("allows an absolute path inside root", () => {
    expect(resolveInside(root, "/work/project/src/a.ts")).toBe("/work/project/src/a.ts");
  });

  test("isInside reflects containment", () => {
    expect(isInside(root, "src/a.ts")).toBe(true);
    expect(isInside(root, "../x")).toBe(false);
  });
});
