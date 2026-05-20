import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { bashTool } from "../src/tools/bash.js";
import { fileReadTool } from "../src/tools/fileRead.js";
import { fileWriteTool } from "../src/tools/fileWrite.js";
import { fileEditTool } from "../src/tools/fileEdit.js";
import { globTool } from "../src/tools/glob.js";
import { grepTool } from "../src/tools/grep.js";
import type { ToolUseContext } from "../src/tools/types.js";

let testDir: string;
let context: ToolUseContext;

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), "alfred-test-"));
  context = {
    abortController: new AbortController(),
    workingDir: testDir,
    readFileState: new Map(),
    permissionContext: {
      mode: "bypass",
      allowedTools: new Set(),
      deniedTools: new Set(),
      workingDir: testDir,
    },
  };
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("BashTool", () => {
  test("executes echo and returns output", async () => {
    const result = await bashTool.call({ command: "echo hello" }, context);
    expect(result.content).toContain("hello");
    expect(result.isError).toBeUndefined();
  });

  test("detects read-only commands", () => {
    expect(bashTool.isReadOnly({ command: "ls" })).toBe(true);
    expect(bashTool.isReadOnly({ command: "git status" })).toBe(true);
    expect(bashTool.isReadOnly({ command: "rm -rf /" })).toBe(false);
  });

  test("detects destructive commands", () => {
    expect(bashTool.isDestructive({ command: "rm file.txt" })).toBe(true);
    expect(bashTool.isDestructive({ command: "echo safe" })).toBe(false);
  });

  test("reports error for failing command", async () => {
    const result = await bashTool.call({ command: "false" }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Exit code");
  });
});

describe("FileWriteTool + FileReadTool", () => {
  test("write then read roundtrip", async () => {
    const writeResult = await fileWriteTool.call(
      { path: "test.txt", content: "Hello, Alfred!" },
      context,
    );
    expect(writeResult.isError).toBeUndefined();

    const readResult = await fileReadTool.call(
      { path: "test.txt" },
      context,
    );
    expect(readResult.content).toContain("Hello, Alfred!");
  });

  test("read nonexistent file returns error", async () => {
    const result = await fileReadTool.call(
      { path: "nonexistent.txt" },
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  test("write creates parent directories", async () => {
    const result = await fileWriteTool.call(
      { path: "nested/dir/file.txt", content: "nested content" },
      context,
    );
    expect(result.isError).toBeUndefined();

    const read = await fileReadTool.call(
      { path: "nested/dir/file.txt" },
      context,
    );
    expect(read.content).toContain("nested content");
  });
});

describe("FileEditTool", () => {
  test("replaces string in file", async () => {
    await fileWriteTool.call(
      { path: "edit-test.txt", content: "Hello world\nGoodbye world" },
      context,
    );

    const result = await fileEditTool.call(
      { path: "edit-test.txt", old_string: "Hello world", new_string: "Hi world" },
      context,
    );
    expect(result.isError).toBeUndefined();

    const read = await fileReadTool.call({ path: "edit-test.txt" }, context);
    expect(read.content).toContain("Hi world");
    expect(read.content).toContain("Goodbye world");
  });

  test("fails when old_string not found", async () => {
    await fileWriteTool.call(
      { path: "edit-fail.txt", content: "unchanged" },
      context,
    );

    const result = await fileEditTool.call(
      { path: "edit-fail.txt", old_string: "not present", new_string: "something" },
      context,
    );
    expect(result.isError).toBe(true);
  });

  test("fails on ambiguous match without replace_all", async () => {
    await fileWriteTool.call(
      { path: "ambiguous.txt", content: "aaa\naaa\naaa" },
      context,
    );

    const result = await fileEditTool.call(
      { path: "ambiguous.txt", old_string: "aaa", new_string: "bbb" },
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("3 occurrences");
  });

  test("replace_all replaces all occurrences", async () => {
    await fileWriteTool.call(
      { path: "replace-all.txt", content: "aaa bbb aaa" },
      context,
    );

    const result = await fileEditTool.call(
      { path: "replace-all.txt", old_string: "aaa", new_string: "ccc", replace_all: true },
      context,
    );
    expect(result.isError).toBeUndefined();

    const read = await fileReadTool.call({ path: "replace-all.txt" }, context);
    expect(read.content).toContain("ccc bbb ccc");
  });
});

describe("GlobTool", () => {
  beforeAll(async () => {
    await fileWriteTool.call({ path: "src/main.ts", content: "export {}" }, context);
    await fileWriteTool.call({ path: "src/utils.ts", content: "export {}" }, context);
    await fileWriteTool.call({ path: "README.md", content: "# test" }, context);
  });

  test("finds files matching pattern", async () => {
    const result = await globTool.call({ pattern: "**/*.ts" }, context);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("main.ts");
    expect(result.content).toContain("utils.ts");
  });

  test("returns message when no matches", async () => {
    const result = await globTool.call({ pattern: "**/*.xyz" }, context);
    expect(result.content).toContain("No files matched");
  });
});

describe("GrepTool", () => {
  beforeAll(async () => {
    await fileWriteTool.call({ path: "grep-test.txt", content: "Hello World\nFoo Bar\nhello again" }, context);
  });

  test("finds matching content", async () => {
    const result = await grepTool.call({ pattern: "Hello" }, context);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Hello World");
  });

  test("case insensitive search", async () => {
    const result = await grepTool.call({ pattern: "hello", ignoreCase: true }, context);
    expect(result.content).toContain("Hello World");
    expect(result.content).toContain("hello again");
  });

  test("no matches returns appropriate message", async () => {
    const result = await grepTool.call({ pattern: "zzz_not_found_zzz" }, context);
    expect(result.content).toContain("No matches");
  });
});
