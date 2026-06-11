/**
 * Tests for `alfred init` (src/cli/init.ts): scaffolding, refusal to
 * overwrite without --force, and .gitignore handling (pure function + IO).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitignoreWithAlfred, runInit } from "../src/cli/init.ts";
import { loadFeatureList } from "../src/harness/featureList.ts";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    `alfred-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("gitignoreWithAlfred", () => {
  test("creates a block from scratch", () => {
    expect(gitignoreWithAlfred(null)).toContain(".alfred/");
  });

  test("appends to existing content exactly once", () => {
    const next = gitignoreWithAlfred("node_modules/\n");
    expect(next).toContain("node_modules/");
    expect(next).toContain(".alfred/");
    expect(gitignoreWithAlfred("node_modules/\n.alfred/\n")).toBeNull();
    expect(gitignoreWithAlfred(".alfred\n")).toBeNull();
  });
});

describe("runInit", () => {
  test("scaffolds a valid feature_list.json and refuses a second run", async () => {
    const cwd = await makeTempDir();
    expect(await runInit(cwd, {})).toBe(0);
    const list = await loadFeatureList(join(cwd, "feature_list.json"));
    expect(list.features.length).toBe(1);
    expect(list.features[0]?.status).toBe("pending");

    expect(await runInit(cwd, {})).toBe(1); // refuses without --force
    expect(await runInit(cwd, { force: true })).toBe(0);
  });

  test("appends .alfred/ to an existing .gitignore", async () => {
    const cwd = await makeTempDir();
    await Bun.write(join(cwd, ".gitignore"), "node_modules/\n");
    await runInit(cwd, {});
    const gitignore = await Bun.file(join(cwd, ".gitignore")).text();
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain(".alfred/");
  });

  test("leaves non-repo dirs without a .gitignore alone", async () => {
    const cwd = await makeTempDir();
    await runInit(cwd, {});
    expect(await Bun.file(join(cwd, ".gitignore")).exists()).toBe(false);
  });
});
