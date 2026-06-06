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
});
