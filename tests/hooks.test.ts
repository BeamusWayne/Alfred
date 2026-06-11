/**
 * Hooks engine tests — ADR 0001 §7.5 (hooks, exit-2-blocks)
 *
 * All hook scripts are defined as inline `sh -c` commands or written into a
 * temp directory. The temp directory is cleaned up after each test group.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHooksConfig, runHooks } from "../src/hooks/engine.ts";
import type { HooksConfig } from "../src/hooks/types.ts";

// ---------------------------------------------------------------------------
// Temp directory setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "alfred-hooks-test-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeConfig(...hooks: HooksConfig["hooks"][number][]): HooksConfig {
  return { hooks };
}

const basePayload = { toolName: "bash", input: { cmd: "ls" } };

// ---------------------------------------------------------------------------
// 1. exit-2 blocks with stderr reason (PreToolUse)
// ---------------------------------------------------------------------------

describe("exit-2 blocks on PreToolUse", () => {
  test("hook exiting 2 blocks and surfaces stderr as reason", async () => {
    const config = makeConfig({
      event: "PreToolUse",
      command: 'echo "not allowed" >&2; exit 2',
      toolPattern: "*",
    });

    const outcome = await runHooks(config, "PreToolUse", basePayload);

    expect(outcome.block).toBe(true);
    expect(outcome.reason).toContain("not allowed");
  });
});

// ---------------------------------------------------------------------------
// 2. exit-0 allows
// ---------------------------------------------------------------------------

describe("exit-0 allows the tool call", () => {
  test("hook exiting 0 returns block:false", async () => {
    const config = makeConfig({
      event: "PreToolUse",
      command: "exit 0",
      toolPattern: "*",
    });

    const outcome = await runHooks(config, "PreToolUse", basePayload);

    expect(outcome.block).toBe(false);
    expect(outcome.updatedInput).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. stdout JSON rewrites input
// ---------------------------------------------------------------------------

describe("stdout JSON rewrite", () => {
  test('hook echoing {"updatedInput":{…}} carries the rewrite forward', async () => {
    const config = makeConfig({
      event: "PreToolUse",
      command: 'printf \'{"updatedInput":{"x":1}}\'',
      toolPattern: "*",
    });

    const outcome = await runHooks(config, "PreToolUse", basePayload);

    expect(outcome.block).toBe(false);
    expect(outcome.updatedInput).toEqual({ x: 1 });
  });

  test("rewrite accumulates across multiple hooks (last writer wins per key)", async () => {
    const config = makeConfig(
      {
        event: "PreToolUse",
        command: 'printf \'{"updatedInput":{"x":1,"y":10}}\'',
        toolPattern: "*",
      },
      {
        event: "PreToolUse",
        command: 'printf \'{"updatedInput":{"x":2}}\'',
        toolPattern: "*",
      },
    );

    const outcome = await runHooks(config, "PreToolUse", basePayload);

    expect(outcome.block).toBe(false);
    // x overwritten by second hook; y preserved from first
    expect(outcome.updatedInput).toEqual({ x: 2, y: 10 });
  });
});

// ---------------------------------------------------------------------------
// 4. toolPattern matching
// ---------------------------------------------------------------------------

describe("toolPattern matching", () => {
  test('"*" matches any tool', async () => {
    const config = makeConfig({
      event: "PreToolUse",
      command: 'echo "blocked" >&2; exit 2',
      toolPattern: "*",
    });

    const outcome = await runHooks(config, "PreToolUse", {
      toolName: "read_file",
      input: {},
    });

    expect(outcome.block).toBe(true);
  });

  test("exact pattern matches correct tool", async () => {
    const config = makeConfig({
      event: "PreToolUse",
      command: 'echo "blocked" >&2; exit 2',
      toolPattern: "bash",
    });

    const outcome = await runHooks(config, "PreToolUse", {
      toolName: "bash",
      input: {},
    });

    expect(outcome.block).toBe(true);
  });

  test("exact pattern does NOT match a different tool", async () => {
    const config = makeConfig({
      event: "PreToolUse",
      command: 'echo "blocked" >&2; exit 2',
      toolPattern: "bash",
    });

    const outcome = await runHooks(config, "PreToolUse", {
      toolName: "read_file",
      input: {},
    });

    // The hook pattern does not match, so no hooks run → allow.
    expect(outcome.block).toBe(false);
  });

  test("missing toolPattern acts as wildcard", async () => {
    const config = makeConfig({
      event: "PreToolUse",
      command: 'echo "blocked" >&2; exit 2',
      // toolPattern omitted intentionally
    });

    const outcome = await runHooks(config, "PreToolUse", {
      toolName: "any_tool",
      input: {},
    });

    expect(outcome.block).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. PostToolUse exit-2 does NOT block
// ---------------------------------------------------------------------------

describe("PostToolUse exit-2 does not block", () => {
  test("a PostToolUse hook exiting 2 returns block:false", async () => {
    const config = makeConfig({
      event: "PostToolUse",
      command: 'echo "observation only" >&2; exit 2',
      toolPattern: "*",
    });

    const outcome = await runHooks(config, "PostToolUse", basePayload);

    expect(outcome.block).toBe(false);
  });

  test("PostToolUse still captures updatedInput from exit-0 hooks", async () => {
    const config = makeConfig({
      event: "PostToolUse",
      command: 'printf \'{"updatedInput":{"observed":true}}\'',
      toolPattern: "*",
    });

    const outcome = await runHooks(config, "PostToolUse", basePayload);

    expect(outcome.block).toBe(false);
    expect(outcome.updatedInput).toEqual({ observed: true });
  });
});

// ---------------------------------------------------------------------------
// 6. Missing config file → no hooks → allow
// ---------------------------------------------------------------------------

describe("missing config file", () => {
  test("loadHooksConfig with nonexistent path returns empty hooks", async () => {
    const missingPath = join(tmpDir, "does-not-exist.json");
    const cfg = await loadHooksConfig(missingPath);

    expect(cfg.hooks).toHaveLength(0);
  });

  test("empty hooks config allows every tool call", async () => {
    const config: HooksConfig = { hooks: [] };

    const outcome = await runHooks(config, "PreToolUse", basePayload);

    expect(outcome.block).toBe(false);
    expect(outcome.updatedInput).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. loadHooksConfig validates a well-formed JSON file
// ---------------------------------------------------------------------------

describe("loadHooksConfig", () => {
  test("loads a valid hooks.json", async () => {
    const hookFile = join(tmpDir, "hooks.json");
    writeFileSync(
      hookFile,
      JSON.stringify({
        hooks: [
          {
            event: "PreToolUse",
            command: "exit 0",
            toolPattern: "bash",
            timeoutMs: 5000,
          },
        ],
      }),
    );

    const cfg = await loadHooksConfig(hookFile);

    expect(cfg.hooks).toHaveLength(1);
    expect(cfg.hooks[0]?.event).toBe("PreToolUse");
    expect(cfg.hooks[0]?.command).toBe("exit 0");
    expect(cfg.hooks[0]?.toolPattern).toBe("bash");
    expect(cfg.hooks[0]?.timeoutMs).toBe(5000);
  });

  test("throws on malformed JSON", async () => {
    const badFile = join(tmpDir, "bad.json");
    writeFileSync(badFile, "{ not json }");

    await expect(loadHooksConfig(badFile)).rejects.toThrow("not valid JSON");
  });

  test("throws on schema violation", async () => {
    const badSchema = join(tmpDir, "schema-fail.json");
    writeFileSync(
      badSchema,
      JSON.stringify({ hooks: [{ event: "UnknownEvent", command: "exit 0" }] }),
    );

    await expect(loadHooksConfig(badSchema)).rejects.toThrow("failed validation");
  });
});

// ---------------------------------------------------------------------------
// 8. Non-zero non-2 exit is lenient (hook error ≠ block)
// ---------------------------------------------------------------------------

describe("non-zero non-2 exit is lenient", () => {
  test("hook exiting 1 does not block", async () => {
    const config = makeConfig({
      event: "PreToolUse",
      command: "exit 1",
      toolPattern: "*",
    });

    const outcome = await runHooks(config, "PreToolUse", basePayload);

    expect(outcome.block).toBe(false);
  });

  test("hook exiting 3 does not block", async () => {
    const config = makeConfig({
      event: "PreToolUse",
      command: "exit 3",
      toolPattern: "*",
    });

    const outcome = await runHooks(config, "PreToolUse", basePayload);

    expect(outcome.block).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. First PreToolUse blocker short-circuits remaining hooks
// ---------------------------------------------------------------------------

describe("first blocker short-circuits", () => {
  test("second hook does not run after first hook blocks", async () => {
    // If the second hook ran and succeeded, updatedInput would be set.
    // Blocker wins, so updatedInput must be absent.
    const config = makeConfig(
      {
        event: "PreToolUse",
        command: 'echo "stop" >&2; exit 2',
        toolPattern: "*",
      },
      {
        event: "PreToolUse",
        command: 'printf \'{"updatedInput":{"ran":true}}\'',
        toolPattern: "*",
      },
    );

    const outcome = await runHooks(config, "PreToolUse", basePayload);

    expect(outcome.block).toBe(true);
    expect(outcome.updatedInput).toBeUndefined();
  });
});
