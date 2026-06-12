/**
 * Hooks engine tests — ADR 0001 §7.5 (hooks, exit-2-blocks)
 *
 * All hook scripts are defined as inline `sh -c` commands or written into a
 * temp directory. The temp directory is cleaned up after each test group.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// 10. Claude Code-compatible stdin payload
// ---------------------------------------------------------------------------

/** Run one hook that dumps its stdin to a file; return the parsed payload. */
async function capturePayload(
  event: Parameters<typeof runHooks>[1],
  payload: Parameters<typeof runHooks>[2],
  opts?: Parameters<typeof runHooks>[3],
): Promise<Record<string, unknown>> {
  const file = join(tmpDir, `payload-${crypto.randomUUID()}.json`);
  const config = makeConfig({ event, command: `cat > ${file}` });
  await runHooks(config, event, payload, opts);
  return JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
}

describe("Claude Code-compatible payload", () => {
  test("PreToolUse carries snake_case fields plus legacy keys", async () => {
    const got = await capturePayload(
      "PreToolUse",
      { toolName: "bash", input: { cmd: "ls" } },
      { context: { sessionId: "ses-1", cwd: "/tmp/project", model: "test-model" } },
    );

    expect(got["session_id"]).toBe("ses-1");
    expect(got["hook_event_name"]).toBe("PreToolUse");
    expect(got["cwd"]).toBe("/tmp/project");
    expect(got["model"]).toBe("test-model");
    expect(got["tool_name"]).toBe("bash");
    expect(got["tool_input"]).toEqual({ cmd: "ls" });
    // pre-0.7 hooks keep working:
    expect(got["toolName"]).toBe("bash");
    expect(got["input"]).toEqual({ cmd: "ls" });
  });

  test("PostToolUse carries tool_response", async () => {
    const got = await capturePayload(
      "PostToolUse",
      { toolName: "bash", input: { cmd: "ls" }, toolResponse: "file-a\nfile-b" },
      { context: { sessionId: "ses-2", cwd: "/tmp/project" } },
    );

    expect(got["hook_event_name"]).toBe("PostToolUse");
    expect(got["tool_response"]).toBe("file-a\nfile-b");
  });

  test("session_id defaults to a stable per-process id when unset", async () => {
    const first = await capturePayload("PreToolUse", basePayload);
    const second = await capturePayload("PreToolUse", basePayload);

    expect(typeof first["session_id"]).toBe("string");
    expect((first["session_id"] as string).length).toBeGreaterThan(0);
    expect(first["session_id"]).toBe(second["session_id"]);
  });
});

// ---------------------------------------------------------------------------
// 11. Lifecycle events
// ---------------------------------------------------------------------------

describe("lifecycle events", () => {
  test("SessionStart fires with source and no tool fields", async () => {
    const got = await capturePayload(
      "SessionStart",
      { source: "startup" },
      { context: { sessionId: "ses-3", cwd: "/tmp/project" } },
    );

    expect(got["hook_event_name"]).toBe("SessionStart");
    expect(got["source"]).toBe("startup");
    expect(got["tool_name"]).toBeUndefined();
  });

  test("UserPromptSubmit carries the prompt and can block via exit 2", async () => {
    const got = await capturePayload("UserPromptSubmit", { prompt: "delete everything" });
    expect(got["prompt"]).toBe("delete everything");

    const blocking = makeConfig({
      event: "UserPromptSubmit",
      command: 'echo "prompt rejected" >&2; exit 2',
    });
    const outcome = await runHooks(blocking, "UserPromptSubmit", { prompt: "x" });
    expect(outcome.block).toBe(true);
    expect(outcome.reason).toContain("prompt rejected");
  });

  test("Stop and SessionEnd are observe-only — exit 2 never blocks", async () => {
    for (const event of ["Stop", "SessionEnd"] as const) {
      const config = makeConfig({ event, command: "exit 2" });
      const outcome = await runHooks(config, event, {});
      expect(outcome.block).toBe(false);
    }
  });

  test("an exact toolPattern never matches a lifecycle event", async () => {
    const config = makeConfig({
      event: "SessionStart",
      command: 'echo "ran" >&2; exit 2',
      toolPattern: "bash",
    });

    const outcome = await runHooks(config, "SessionStart", { source: "startup" });

    // Pattern cannot match (lifecycle events carry no tool name) → no hooks ran.
    expect(outcome.block).toBe(false);
  });
});
