/**
 * `alfred doctor` tests — gather in a temp dir, assert checks and render.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { palette } from "../src/cli/colors.ts";
import { type DoctorCheck, gatherDoctor, hasFailure, renderDoctor } from "../src/cli/doctor.ts";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "alfred-doctor-test-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const env = {
  provider: "anthropic",
  model: "test-model",
  which: () => null, // no git, no nightwatch
};

function byName(checks: readonly DoctorCheck[], name: string): DoctorCheck {
  const found = checks.find((c) => c.name === name);
  if (!found) throw new Error(`missing check: ${name}`);
  return found;
}

describe("gatherDoctor", () => {
  test("empty project: runtime ok, hooks/feature_list informational, git warns", async () => {
    const checks = await gatherDoctor(tmpDir, env);

    expect(byName(checks, "runtime").level).toBe("ok");
    expect(byName(checks, "hooks").level).toBe("info");
    expect(byName(checks, "feature_list").level).toBe("info");
    expect(byName(checks, "last receipt").level).toBe("info");
    expect(byName(checks, "git").level).toBe("warn");
    expect(byName(checks, "recorder").level).toBe("info");
  });

  test("old bun version is a hard failure", async () => {
    const checks = await gatherDoctor(tmpDir, { ...env, bunVersion: "1.2.9" });

    expect(byName(checks, "runtime").level).toBe("fail");
    expect(hasFailure(checks)).toBe(true);
  });

  test("valid hooks config is reported with its events", async () => {
    const dir = join(tmpDir, "with-hooks");
    mkdirSync(join(dir, ".alfred"), { recursive: true });
    writeFileSync(
      join(dir, ".alfred", "hooks.json"),
      JSON.stringify({
        hooks: [
          { event: "SessionStart", command: "exit 0" },
          { event: "PostToolUse", command: "exit 0" },
        ],
      }),
    );

    const checks = await gatherDoctor(dir, env);
    const hooks = byName(checks, "hooks");

    expect(hooks.level).toBe("ok");
    expect(hooks.detail).toContain("SessionStart");
    expect(hooks.detail).toContain("PostToolUse");
  });

  test("malformed hooks config is a hard failure with a fix", async () => {
    const dir = join(tmpDir, "bad-hooks");
    mkdirSync(join(dir, ".alfred"), { recursive: true });
    writeFileSync(join(dir, ".alfred", "hooks.json"), "{ not json");

    const checks = await gatherDoctor(dir, env);
    const hooks = byName(checks, "hooks");

    expect(hooks.level).toBe("fail");
    expect(hooks.fix).toContain(".alfred/hooks.json");
  });

  test("nightwatch on PATH flips the recorder check to ok", async () => {
    const checks = await gatherDoctor(tmpDir, {
      ...env,
      which: (bin: string) => (bin === "nightwatch" ? "/usr/local/bin/nightwatch" : null),
    });

    const recorder = byName(checks, "recorder");
    expect(recorder.level).toBe("ok");
    expect(recorder.detail).toContain("nightwatch init --agent alfred");
  });
});

describe("renderDoctor", () => {
  test("renders marks, fixes, and the summary line", async () => {
    const checks = await gatherDoctor(tmpDir, env);
    const out = renderDoctor(checks, palette({ isTTY: false }));

    expect(out).toContain("alfred doctor");
    expect(out).toContain("runtime");
    expect(out).toContain("→"); // at least one fix line
    expect(out).toMatch(/warning|failure|all checks passed/);
  });
});
