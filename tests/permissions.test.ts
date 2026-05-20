import { describe, test, expect } from "bun:test";
import { createPermissionContext, evaluatePermission, parsePermissionMode } from "../src/permissions/index.js";
import type { PermissionResult, ToolPermissionContext } from "../src/tools/types.js";

const defaultToolCheck = async (input: Record<string, unknown>): Promise<PermissionResult> => ({
  behavior: "ask",
  updatedInput: input,
  reason: "Default: needs user approval",
});

describe("permission modes", () => {
  test("bypass mode allows everything", async () => {
    const ctx = createPermissionContext(
      { mode: "bypass", allowedTools: [], deniedTools: [], rules: [] },
      "/tmp",
    );
    const result = await evaluatePermission("bash", { command: "rm -rf /" }, defaultToolCheck, ctx);
    expect(result.behavior).toBe("allow");
  });

  test("plan mode denies all tools", async () => {
    const ctx = createPermissionContext(
      { mode: "plan", allowedTools: [], deniedTools: [], rules: [] },
      "/tmp",
    );
    const result = await evaluatePermission("bash", { command: "ls" }, defaultToolCheck, ctx);
    expect(result.behavior).toBe("deny");
    expect(result.reason).toContain("plan mode");
  });

  test("denied tools always block regardless of mode", async () => {
    const ctx = createPermissionContext(
      { mode: "bypass", allowedTools: [], deniedTools: ["bash"], rules: [] },
      "/tmp",
    );
    const result = await evaluatePermission("bash", { command: "ls" }, defaultToolCheck, ctx);
    expect(result.behavior).toBe("deny");
    expect(result.reason).toContain("denied list");
  });

  test("allowed tools auto-approve in default mode", async () => {
    const ctx = createPermissionContext(
      { mode: "default", allowedTools: ["file_read"], deniedTools: [], rules: [] },
      "/tmp",
    );
    const result = await evaluatePermission("file_read", { path: "test.txt" }, defaultToolCheck, ctx);
    expect(result.behavior).toBe("allow");
  });

  test("default mode delegates to tool checkPermissions", async () => {
    const ctx = createPermissionContext(
      { mode: "default", allowedTools: [], deniedTools: [], rules: [] },
      "/tmp",
    );
    const result = await evaluatePermission("bash", { command: "ls" }, defaultToolCheck, ctx);
    expect(result.behavior).toBe("ask");
  });

  test("auto mode delegates to tool checkPermissions", async () => {
    const ctx = createPermissionContext(
      { mode: "auto", allowedTools: [], deniedTools: [], rules: [] },
      "/tmp",
    );
    const result = await evaluatePermission("bash", { command: "ls" }, defaultToolCheck, ctx);
    expect(result.behavior).toBe("ask");
  });
});

describe("parsePermissionMode", () => {
  test("parses valid modes", () => {
    expect(parsePermissionMode("default")).toBe("default");
    expect(parsePermissionMode("plan")).toBe("plan");
    expect(parsePermissionMode("auto")).toBe("auto");
    expect(parsePermissionMode("bypass")).toBe("bypass");
  });

  test("throws for invalid mode", () => {
    expect(() => parsePermissionMode("invalid")).toThrow("Invalid permission mode");
  });
});

describe("createPermissionContext", () => {
  test("creates context with correct sets", () => {
    const ctx = createPermissionContext(
      { mode: "auto", allowedTools: ["bash", "read"], deniedTools: ["rm"], rules: [] },
      "/home/user/project",
    );
    expect(ctx.mode).toBe("auto");
    expect(ctx.allowedTools.has("bash")).toBe(true);
    expect(ctx.allowedTools.has("read")).toBe(true);
    expect(ctx.deniedTools.has("rm")).toBe(true);
    expect(ctx.workingDir).toBe("/home/user/project");
  });
});
