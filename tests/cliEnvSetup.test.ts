/**
 * Tests for `alfred init`'s provider setup (src/cli/envSetup.ts): .env
 * upsert (pure), masked-input keystroke handling (pure), .gitignore
 * protection, and the interactive flow over injected IO. The secret value
 * must never appear in any output line, and the file lands chmod 0600.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyKeystroke,
  type EnvSetupIo,
  envFileKeys,
  gitignoreWithEnv,
  runEnvSetup,
  upsertEnvLines,
} from "../src/cli/envSetup.ts";
import { runInit } from "../src/cli/init.ts";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    `alfred-envsetup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  tempDirs = [];
});

// ---------------------------------------------------------------------------
// Pure pieces
// ---------------------------------------------------------------------------

describe("upsertEnvLines", () => {
  test("creates content from scratch with a trailing newline", () => {
    expect(upsertEnvLines(null, { A: "1", B: "2" })).toBe("A=1\nB=2\n");
  });

  test("replaces existing assignments and preserves everything else", () => {
    const existing = "# my secrets\nexport ANTHROPIC_API_KEY=old\nOTHER=keep\n";
    const next = upsertEnvLines(existing, { ANTHROPIC_API_KEY: "new", ALFRED_MODEL: "glm-4.7" });
    expect(next).toBe("# my secrets\nANTHROPIC_API_KEY=new\nOTHER=keep\nALFRED_MODEL=glm-4.7\n");
  });

  test("does not touch keys that merely share a prefix", () => {
    const next = upsertEnvLines("ALFRED_MODEL_EDITOR=x\n", { ALFRED_MODEL: "y" });
    expect(next).toBe("ALFRED_MODEL_EDITOR=x\nALFRED_MODEL=y\n");
  });
});

describe("envFileKeys", () => {
  test("collects assigned keys, including export form", () => {
    const keys = envFileKeys("# c\nA=1\nexport B=2\nnot a line\n");
    expect(keys.has("A")).toBe(true);
    expect(keys.has("B")).toBe(true);
    expect(keys.has("C")).toBe(false);
  });
});

describe("classifyKeystroke", () => {
  test("maps enter/backspace/ctrl-c/printable/control", () => {
    expect(classifyKeystroke("\r")).toEqual({ kind: "submit" });
    expect(classifyKeystroke("\n")).toEqual({ kind: "submit" });
    expect(classifyKeystroke("\x7f")).toEqual({ kind: "backspace" });
    expect(classifyKeystroke("\b")).toEqual({ kind: "backspace" });
    expect(classifyKeystroke("\x03")).toEqual({ kind: "abort" });
    expect(classifyKeystroke("k")).toEqual({ kind: "append", text: "k" });
    expect(classifyKeystroke("\x1b")).toEqual({ kind: "ignore" });
  });
});

describe("gitignoreWithEnv", () => {
  test("adds .env exactly once", () => {
    expect(gitignoreWithEnv(null)).toContain(".env");
    const appended = gitignoreWithEnv("node_modules/\n");
    expect(appended).toContain("node_modules/");
    expect(appended).toContain(".env");
    expect(gitignoreWithEnv(".env\n")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Interactive flow over injected IO
// ---------------------------------------------------------------------------

function scriptedIo(answers: ReadonlyArray<string | null>): EnvSetupIo & {
  readonly lines: string[];
} {
  const queue = [...answers];
  const lines: string[] = [];
  // Preserve scripted nulls (an aborted prompt) — `??` would swallow them.
  const next = async () => (queue.length > 0 ? (queue.shift() as string | null) : "");
  return { lines, ask: next, askSecret: next, out: (line: string) => lines.push(line) };
}

describe("runEnvSetup", () => {
  test("writes answered vars to .env with 0600 and protects .gitignore", async () => {
    const cwd = await makeTempDir();
    await mkdir(join(cwd, ".git"), { recursive: true });
    await Bun.write(join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
    const io = scriptedIo([
      "https://open.bigmodel.cn/api/anthropic", // ALFRED_BASE_URL
      "sk-test-secret-value", // ANTHROPIC_API_KEY (masked)
      "glm-4.7", // ALFRED_MODEL
    ]);

    await runEnvSetup(cwd, io);

    const env = await Bun.file(join(cwd, ".env")).text();
    expect(env).toContain("ALFRED_BASE_URL=https://open.bigmodel.cn/api/anthropic");
    expect(env).toContain("ANTHROPIC_API_KEY=sk-test-secret-value");
    expect(env).toContain("ALFRED_MODEL=glm-4.7");
    const mode = (await stat(join(cwd, ".env"))).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(await Bun.file(join(cwd, ".gitignore")).text()).toContain(".env");
    // The secret never appears in any printed line.
    expect(io.lines.join("\n")).not.toContain("sk-test-secret-value");
  });

  test("empty answers keep the existing file untouched", async () => {
    const cwd = await makeTempDir();
    await Bun.write(join(cwd, ".env"), "ANTHROPIC_API_KEY=already\n");
    const io = scriptedIo(["", "", ""]);

    await runEnvSetup(cwd, io);

    expect(await Bun.file(join(cwd, ".env")).text()).toBe("ANTHROPIC_API_KEY=already\n");
  });

  test("an aborted prompt writes nothing", async () => {
    const cwd = await makeTempDir();
    const io = scriptedIo(["https://example.com", null]);

    await runEnvSetup(cwd, io);

    expect(await Bun.file(join(cwd, ".env")).exists()).toBe(false);
  });

  test("a non-URL base URL is rejected and skipped", async () => {
    const cwd = await makeTempDir();
    const io = scriptedIo(["bigmodel.cn", "sk-x", ""]);

    await runEnvSetup(cwd, io);

    const env = await Bun.file(join(cwd, ".env")).text();
    expect(env).not.toContain("ALFRED_BASE_URL");
    expect(env).toContain("ANTHROPIC_API_KEY=sk-x");
  });
});

describe("runInit + env setup", () => {
  test("scaffolds and configures .env in one pass", async () => {
    const cwd = await makeTempDir();
    const io = scriptedIo(["", "sk-from-init", ""]);

    expect(await runInit(cwd, {}, io)).toBe(0);

    expect(await Bun.file(join(cwd, "feature_list.json")).exists()).toBe(true);
    expect(await Bun.file(join(cwd, ".env")).text()).toContain("ANTHROPIC_API_KEY=sk-from-init");
  });

  test("an already-initialized project can still (re)configure the key", async () => {
    const cwd = await makeTempDir();
    await Bun.write(join(cwd, "feature_list.json"), '{"features":[]}');
    const io = scriptedIo(["", "sk-reconfigure", ""]);

    expect(await runInit(cwd, {}, io)).toBe(1);

    expect(await Bun.file(join(cwd, ".env")).text()).toContain("ANTHROPIC_API_KEY=sk-reconfigure");
  });
});
