import { test, expect, describe } from "bun:test";
import { evaluatePermission } from "../src/permissions/evaluate.ts";
import { allow, ask, deny, type PermissionResult, type ToolPermissionContext } from "../src/permissions/types.ts";

function ctx(
  mode: ToolPermissionContext["mode"],
  opts: { allowed?: string[]; denied?: string[] } = {},
): ToolPermissionContext {
  return {
    mode,
    allowedTools: new Set(opts.allowed ?? []),
    deniedTools: new Set(opts.denied ?? []),
    workingDir: "/w",
  };
}

const asks = async (): Promise<PermissionResult> => ask("needs ok");
const allows = async (): Promise<PermissionResult> => allow();
const denies = async (): Promise<PermissionResult> => deny("kill-list");

async function decide(
  p: { isReadOnly?: boolean; check?: () => Promise<PermissionResult>; ctx: ToolPermissionContext; name?: string },
) {
  return evaluatePermission({
    toolName: p.name ?? "bash",
    isReadOnly: p.isReadOnly ?? false,
    input: {},
    check: p.check ?? asks,
    ctx: p.ctx,
  });
}

describe("evaluatePermission", () => {
  test("denylist denies even under bypass", async () => {
    expect((await decide({ ctx: ctx("bypass", { denied: ["bash"] }) })).behavior).toBe("deny");
  });

  test("a tool-level deny (kill-list) beats bypass", async () => {
    expect((await decide({ check: denies, ctx: ctx("bypass") })).behavior).toBe("deny");
  });

  test("read-only is allowed in default mode", async () => {
    expect((await decide({ isReadOnly: true, ctx: ctx("default") })).behavior).toBe("allow");
  });

  test("plan mode denies mutation", async () => {
    expect((await decide({ ctx: ctx("plan") })).behavior).toBe("deny");
  });

  test("default mode asks for mutation", async () => {
    expect((await decide({ ctx: ctx("default") })).behavior).toBe("ask");
  });

  test("bypass allows mutation the tool would only ask for", async () => {
    expect((await decide({ ctx: ctx("bypass") })).behavior).toBe("allow");
  });

  test("allowlist allows the tool", async () => {
    expect((await decide({ ctx: ctx("default", { allowed: ["bash"] }) })).behavior).toBe("allow");
  });

  test("acceptEdits allows a tool that opts into allow", async () => {
    expect((await decide({ check: allows, ctx: ctx("acceptEdits") })).behavior).toBe("allow");
  });

  test("a tool-level deny (kill-list) is honored EVEN when classified read-only", async () => {
    // Read-only is a per-call classification that can be wrong; it must not be a
    // blanket bypass of the tool's kill-list. Previously isReadOnly skipped the
    // check entirely and auto-allowed.
    expect((await decide({ isReadOnly: true, check: denies, ctx: ctx("bypass") })).behavior).toBe("deny");
    expect((await decide({ isReadOnly: true, check: denies, ctx: ctx("default") })).behavior).toBe("deny");
  });
});
