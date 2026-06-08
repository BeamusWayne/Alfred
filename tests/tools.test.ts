import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../src/tools/types.ts";
import { fileReadTool } from "../src/tools/fileRead.ts";
import { fileWriteTool } from "../src/tools/fileWrite.ts";
import { fileEditTool } from "../src/tools/fileEdit.ts";
import { bashTool } from "../src/tools/bash.ts";
import { globTool } from "../src/tools/glob.ts";
import { grepTool } from "../src/tools/grep.ts";
import { PathEscapeError } from "../src/tools/lib/paths.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "alfred-tools-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeCtx(mode: ToolContext["permissions"]["mode"] = "acceptEdits"): ToolContext {
  return {
    workingDir: dir,
    signal: new AbortController().signal,
    readFileState: new Map(),
    permissions: { mode, allowedTools: new Set(), deniedTools: new Set(), workingDir: dir },
  };
}

describe("file tools", () => {
  test("write then read round-trips with line numbers + records state", async () => {
    const ctx = makeCtx();
    await fileWriteTool.call({ path: "a.txt", content: "line1\nline2" }, ctx);
    const r = await fileReadTool.call({ path: "a.txt" }, ctx);
    expect(r.content).toContain("1\tline1");
    expect(r.content).toContain("2\tline2");
    expect(ctx.readFileState.has(join(dir, "a.txt"))).toBe(true);
  });

  test("edit replaces an exact, unique snippet after read", async () => {
    const ctx = makeCtx();
    await fileWriteTool.call({ path: "a.ts", content: "const x = 1;\n" }, ctx);
    await fileReadTool.call({ path: "a.ts" }, ctx);
    const r = await fileEditTool.call(
      { path: "a.ts", old_string: "const x = 1;", new_string: "const x = 2;" },
      ctx,
    );
    expect(r.isError).toBeFalsy();
    expect(await Bun.file(join(dir, "a.ts")).text()).toBe("const x = 2;\n");
  });

  test("edit refuses a file that was not read first", async () => {
    const ctx = makeCtx();
    await writeFile(join(dir, "b.ts"), "hello");
    const r = await fileEditTool.call({ path: "b.ts", old_string: "hello", new_string: "bye" }, ctx);
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain("before editing");
  });

  test("edit detects a stale (changed-on-disk) file", async () => {
    const ctx = makeCtx();
    await fileWriteTool.call({ path: "c.ts", content: "v1" }, ctx);
    ctx.readFileState.set(join(dir, "c.ts"), { content: "v1", mtimeMs: 0 });
    const r = await fileEditTool.call({ path: "c.ts", old_string: "v1", new_string: "v2" }, ctx);
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain("changed on disk");
  });

  test("edit tolerates indentation drift (fuzzy match)", async () => {
    const ctx = makeCtx();
    await fileWriteTool.call({ path: "d.ts", content: "\tfoo(1);\n" }, ctx);
    await fileReadTool.call({ path: "d.ts" }, ctx);
    const r = await fileEditTool.call(
      { path: "d.ts", old_string: "  foo(1);", new_string: "  foo(2);" },
      ctx,
    );
    expect(r.isError).toBeFalsy();
    expect(await Bun.file(join(dir, "d.ts")).text()).toBe("  foo(2);\n");
  });

  test("edit rejects an ambiguous match", async () => {
    const ctx = makeCtx();
    await fileWriteTool.call({ path: "e.ts", content: "x=1;\nx=1;\n" }, ctx);
    await fileReadTool.call({ path: "e.ts" }, ctx);
    const r = await fileEditTool.call({ path: "e.ts", old_string: "x=1;", new_string: "y=2;" }, ctx);
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain("matches");
  });

  test("file tools are path-jailed to the workspace", async () => {
    const ctx = makeCtx();
    await expect(fileReadTool.call({ path: "../../etc/passwd" }, ctx)).rejects.toThrow(PathEscapeError);
  });
});

describe("search tools", () => {
  test("glob lists matching files", async () => {
    const ctx = makeCtx();
    await fileWriteTool.call({ path: "a.ts", content: "" }, ctx);
    await fileWriteTool.call({ path: "b.ts", content: "" }, ctx);
    await fileWriteTool.call({ path: "c.md", content: "" }, ctx);
    const r = await globTool.call({ pattern: "*.ts" }, ctx);
    expect(r.content).toContain("a.ts");
    expect(r.content).toContain("b.ts");
    expect(r.content).not.toContain("c.md");
  });

  test("grep finds matching lines as file:line:text", async () => {
    const ctx = makeCtx();
    await fileWriteTool.call({ path: "src.ts", content: "alpha\nfind-me here\nbeta" }, ctx);
    const r = await grepTool.call({ pattern: "find-me" }, ctx);
    expect(r.content).toContain("src.ts:2:find-me here");
  });
});

describe("bash safety", () => {
  test("read-only detection is chain-aware", () => {
    expect(bashTool.isReadOnly({ command: "ls -la" })).toBe(true);
    expect(bashTool.isReadOnly({ command: "git status" })).toBe(true);
    expect(bashTool.isReadOnly({ command: "ls && rm x" })).toBe(false);
  });

  test("write-capable commands are NOT classified read-only (no auto-run)", () => {
    for (const cmd of [
      "sed -i 's/a/b/' f",
      "find . -delete",
      "find /tmp -type f -exec rm {} ;",
      "awk 'BEGIN{system(\"rm -rf x\")}'",
      "cat x > out.txt",
      "echo hi >> f",
      "env rm -rf x",
      "cat $(echo f)",
      "grep p f `id`",
      "sort -o /etc/passwd x",
    ]) {
      expect(bashTool.isReadOnly({ command: cmd })).toBe(false);
    }
  });

  test("genuinely read-only commands stay read-only (incl. harmless fd/null redirects)", () => {
    for (const cmd of [
      "ls -la",
      "cat file",
      "grep p f",
      "find . -name '*.ts'",
      "which foo 2>/dev/null",
      "diff a b",
      "git status",
      "wc -l f",
    ]) {
      expect(bashTool.isReadOnly({ command: cmd })).toBe(true);
    }
  });

  test("kill-list denies catastrophic commands (even before bypass)", async () => {
    const ctx = makeCtx();
    expect((await bashTool.checkPermissions({ command: "rm -rf /" }, ctx.permissions)).behavior).toBe("deny");
    expect((await bashTool.checkPermissions({ command: "echo hi" }, ctx.permissions)).behavior).toBe("ask");
  });

  test("kill-list is not defeated by quoting the destructive target", async () => {
    const ctx = makeCtx();
    for (const command of ['rm -rf "/"', "rm -rf '/'", 'rm -rf "/*"', 'rm -rf "$HOME"']) {
      expect((await bashTool.checkPermissions({ command }, ctx.permissions)).behavior).toBe("deny");
    }
    // A quoted real subpath is still not the catastrophic target → not denied.
    expect((await bashTool.checkPermissions({ command: 'rm -rf "/tmp/scratch"' }, ctx.permissions)).behavior).not.toBe("deny");
  });

  test("runs a simple command and captures output", async () => {
    const ctx = makeCtx();
    const r = await bashTool.call({ command: "echo hi" }, ctx);
    expect(String(r.content)).toBe("hi");
  });
});
