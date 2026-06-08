/**
 * Tests for the objective verify gate — ADR 0001 §7.7 (objective verify gate)
 */
import { describe, test, expect } from "bun:test";
import { runVerify, passed } from "../src/harness/verify.ts";
import * as os from "node:os";

const cwd = os.tmpdir();

describe("runVerify", () => {
  test("exit 0 → exitCode 0, passed true", async () => {
    const result = await runVerify("exit 0", { cwd });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(passed(result)).toBe(true);
  });

  test("exit 3 → exitCode 3, passed false", async () => {
    const result = await runVerify("exit 3", { cwd });
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
    expect(passed(result)).toBe(false);
  });

  test("stdout captured", async () => {
    const result = await runVerify("echo hi", { cwd });
    expect(result.stdout.trim()).toBe("hi");
    expect(passed(result)).toBe(true);
  });

  test("stderr captured", async () => {
    const result = await runVerify("echo err 1>&2", { cwd });
    expect(result.stderr.trim()).toBe("err");
  });

  test("timeout sets timedOut:true, passed false", async () => {
    const result = await runVerify("sleep 10", { cwd, timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
    expect(passed(result)).toBe(false);
  });

  test("durationMs is a positive number", async () => {
    const result = await runVerify("exit 0", { cwd });
    expect(result.durationMs).toBeGreaterThan(0);
  });

  test("custom env var is visible to command", async () => {
    const result = await runVerify("echo $ALFRED_TEST_VAR", {
      cwd,
      env: { ALFRED_TEST_VAR: "hello-alfred" },
    });
    expect(result.stdout.trim()).toBe("hello-alfred");
  });

  test("abort signal kills process, passed false", async () => {
    const controller = new AbortController();
    const promise = runVerify("sleep 10", {
      cwd,
      signal: controller.signal,
    });
    // Abort immediately
    controller.abort();
    const result = await promise;
    // Either killed (non-zero exit) or timed-out flag — either way not passed
    expect(passed(result)).toBe(false);
  });

  test("does NOT leak ALFRED_LEDGER_SECRET or API keys to the verify command", async () => {
    // SECURITY: the verify command is model-influenced and unsandboxed; the
    // ledger signing secret leaking would make the Proof Receipt forgeable.
    process.env.ALFRED_LEDGER_SECRET = "top-secret-signing-key";
    process.env.MY_API_KEY = "sk-should-not-leak";
    try {
      const result = await runVerify("echo S=$ALFRED_LEDGER_SECRET K=$MY_API_KEY", { cwd });
      expect(result.stdout).not.toContain("top-secret-signing-key");
      expect(result.stdout).not.toContain("sk-should-not-leak");
      expect(result.stdout.trim()).toBe("S= K="); // both empty inside the child
    } finally {
      delete process.env.ALFRED_LEDGER_SECRET;
      delete process.env.MY_API_KEY;
    }
  });

  test("a non-sensitive inherited env var is still visible", async () => {
    process.env.ALFRED_PLAIN_VAR = "visible-value";
    try {
      const result = await runVerify("echo $ALFRED_PLAIN_VAR", { cwd });
      expect(result.stdout.trim()).toBe("visible-value");
    } finally {
      delete process.env.ALFRED_PLAIN_VAR;
    }
  });

  test("does not hang when a backgrounded child keeps the output pipe open", async () => {
    // sh exits right after `true`, but the backgrounded `sleep` inherits the
    // stdout pipe. Without the bounded drain the reader would block on it for
    // the child's full lifetime; with it, runVerify returns within the grace.
    const result = await runVerify("echo done & sleep 30 & true", { cwd, timeoutMs: 10000 });
    expect(result.durationMs).toBeLessThan(5000); // bounded by drain grace, not 30s
  }, 8000);
});
