import { test, expect, describe, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("allows a nested file literally named '..foo' (not an escape)", () => {
    // rel is "..foo", which is contained — only "../" prefixes are escapes.
    expect(resolveInside(root, "..foo")).toBe("/work/project/..foo");
    expect(resolveInside(root, "src/..bar")).toBe("/work/project/src/..bar");
  });
});

describe("resolveInside — symlink-aware containment", () => {
  const tmps: string[] = [];
  afterEach(async () => {
    for (const d of tmps) await rm(d, { recursive: true, force: true });
    tmps.length = 0;
  });

  async function sandbox(): Promise<{ root: string; outside: string }> {
    const base = await realpath(await mkdtemp(join(tmpdir(), "alfred-paths-")));
    tmps.push(base);
    const root = join(base, "root");
    const outside = join(base, "outside");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    return { root, outside };
  }

  test("rejects following a symlink that points outside the root", async () => {
    const { root, outside } = await sandbox();
    await writeFile(join(outside, "secret.txt"), "top secret", "utf8");
    await symlink(outside, join(root, "escape")); // root/escape -> ../outside

    expect(() => resolveInside(root, "escape/secret.txt")).toThrow(PathEscapeError);
    expect(isInside(root, "escape/secret.txt")).toBe(false);
  });

  test("rejects a symlinked file inside root pointing at an outside file", async () => {
    const { root, outside } = await sandbox();
    const target = join(outside, "secret.txt");
    await writeFile(target, "top secret", "utf8");
    await symlink(target, join(root, "link.txt")); // root/link.txt -> ../outside/secret.txt

    expect(() => resolveInside(root, "link.txt")).toThrow(PathEscapeError);
  });

  test("allows a symlink that stays inside the root", async () => {
    const { root } = await sandbox();
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub", "a.ts"), "export {}", "utf8");
    await symlink(join(root, "sub"), join(root, "alias")); // root/alias -> root/sub

    // Resolves to a real path still under the (realpath'd) root → allowed.
    expect(isInside(root, "alias/a.ts")).toBe(true);
  });

  test("allows a normal nested path in a real temp root (no false /tmp-alias reject)", async () => {
    const { root } = await sandbox();
    await mkdir(join(root, "src"), { recursive: true });
    // New (not-yet-existing) file under an existing real dir must be allowed.
    expect(isInside(root, "src/new-file.ts")).toBe(true);
  });
});
