/**
 * Tests for src/config/roles.ts — ADR 0005 model routing primitives.
 *
 * Covers: resolveRole (role present / absent), fallbackChain (ordering,
 * dedup, primary-first, with/without role), and schema validation.
 */
import { describe, expect, it } from "bun:test";
import { fallbackChain, resolveRole, roleModelMapSchema } from "../src/config/roles.ts";
import type { Role, RoleModelMap } from "../src/config/roles.ts";

// ---------------------------------------------------------------------------
// resolveRole
// ---------------------------------------------------------------------------

describe("resolveRole", () => {
  it("returns the role's model when present in the map", () => {
    const map: RoleModelMap = { architect: "claude-opus-4-5" };
    expect(resolveRole(map, "architect", "claude-sonnet-4-6")).toEqual({
      model: "claude-opus-4-5",
    });
  });

  it("returns fallbackModel when the role is absent from the map", () => {
    const map: RoleModelMap = { architect: "claude-opus-4-5" };
    expect(resolveRole(map, "editor", "claude-sonnet-4-6")).toEqual({
      model: "claude-sonnet-4-6",
    });
  });

  it("returns fallbackModel when map is empty", () => {
    expect(resolveRole({}, "subagent", "claude-haiku-4-5")).toEqual({
      model: "claude-haiku-4-5",
    });
  });

  it("returns the role model even when fallback equals role model", () => {
    const map: RoleModelMap = { editor: "claude-sonnet-4-6" };
    expect(resolveRole(map, "editor", "claude-sonnet-4-6")).toEqual({
      model: "claude-sonnet-4-6",
    });
  });

  it("handles all three roles independently", () => {
    const map: RoleModelMap = {
      architect: "claude-opus-4-5",
      editor: "claude-haiku-4-5",
      subagent: "claude-haiku-4-5",
    };
    const cases: ReadonlyArray<readonly [Role, string]> = [
      ["architect", "claude-opus-4-5"],
      ["editor", "claude-haiku-4-5"],
      ["subagent", "claude-haiku-4-5"],
    ];
    for (const [role, model] of cases) {
      expect(resolveRole(map, role, "fallback").model).toBe(model);
    }
  });
});

// ---------------------------------------------------------------------------
// fallbackChain
// ---------------------------------------------------------------------------

/** Dedupe key mirroring the implementation's provider+model identity. */
const keyOf = (t: { readonly model: string; readonly provider?: string }) =>
  `${t.provider ?? ""}:${t.model}`;

describe("fallbackChain", () => {
  it("returns [primary] when map is empty and no role is given", () => {
    expect(fallbackChain("claude-sonnet-4-6", {})).toEqual([{ model: "claude-sonnet-4-6" }]);
  });

  it("primary is always first", () => {
    const map: RoleModelMap = {
      architect: "claude-opus-4-5",
      editor: "claude-haiku-4-5",
    };
    const chain = fallbackChain("claude-sonnet-4-6", map);
    expect(chain[0]).toEqual({ model: "claude-sonnet-4-6" });
  });

  it("includes all distinct mapped models after primary", () => {
    const map: RoleModelMap = {
      architect: "claude-opus-4-5",
      editor: "claude-haiku-4-5",
    };
    const chain = fallbackChain("claude-sonnet-4-6", map);
    expect(chain).toEqual([
      { model: "claude-sonnet-4-6" },
      { model: "claude-opus-4-5" },
      { model: "claude-haiku-4-5" },
    ]);
  });

  it("deduplicates: primary that also appears in map is not repeated", () => {
    const map: RoleModelMap = {
      architect: "claude-sonnet-4-6",
      editor: "claude-haiku-4-5",
    };
    const chain = fallbackChain("claude-sonnet-4-6", map);
    expect(chain.map((t) => t.model)).toEqual(["claude-sonnet-4-6", "claude-haiku-4-5"]);
    expect(new Set(chain.map(keyOf)).size).toBe(chain.length);
  });

  it("deduplicates: two roles sharing the same model appear once", () => {
    const map: RoleModelMap = {
      architect: "claude-opus-4-5",
      editor: "claude-haiku-4-5",
      subagent: "claude-haiku-4-5",
    };
    const chain = fallbackChain("claude-sonnet-4-6", map);
    expect(chain.map((t) => t.model)).toEqual([
      "claude-sonnet-4-6",
      "claude-opus-4-5",
      "claude-haiku-4-5",
    ]);
    expect(new Set(chain.map(keyOf)).size).toBe(chain.length);
  });

  it("with role: resolved role model becomes head even if different from primary", () => {
    const map: RoleModelMap = {
      architect: "claude-opus-4-5",
      editor: "claude-haiku-4-5",
    };
    const chain = fallbackChain("claude-sonnet-4-6", map, "architect");
    expect(chain[0]).toEqual({ model: "claude-opus-4-5" });
  });

  it("with role: other mapped models stay in the chain", () => {
    const map: RoleModelMap = {
      architect: "claude-opus-4-5",
      editor: "claude-haiku-4-5",
    };
    const chain = fallbackChain("claude-sonnet-4-6", map, "architect");
    expect(chain.map((t) => t.model)).toContain("claude-haiku-4-5");
    expect(new Set(chain.map(keyOf)).size).toBe(chain.length);
  });

  it("with role: role absent from map falls back to primary as head", () => {
    const map: RoleModelMap = { editor: "claude-haiku-4-5" };
    const chain = fallbackChain("claude-sonnet-4-6", map, "architect");
    expect(chain[0]).toEqual({ model: "claude-sonnet-4-6" });
  });

  it("with role: no duplicates when resolved model matches another map entry", () => {
    const map: RoleModelMap = {
      architect: "claude-opus-4-5",
      subagent: "claude-opus-4-5",
      editor: "claude-haiku-4-5",
    };
    const chain = fallbackChain("claude-sonnet-4-6", map, "architect");
    expect(new Set(chain.map(keyOf)).size).toBe(chain.length);
    expect(chain[0]).toEqual({ model: "claude-opus-4-5" });
  });

  it("cross-provider: a provider-qualified role rides the chain intact", () => {
    const map: RoleModelMap = {
      architect: "claude-fable-5",
      editor: { provider: "openai", model: "gpt-5.2" },
    };
    const chain = fallbackChain("claude-sonnet-4-6", map, "architect");
    expect(chain).toEqual([{ model: "claude-fable-5" }, { provider: "openai", model: "gpt-5.2" }]);
  });

  it("cross-provider: same model id on different providers is NOT deduplicated", () => {
    const map: RoleModelMap = {
      architect: { provider: "anthropic", model: "shared-id" },
      editor: { provider: "openai", model: "shared-id" },
    };
    const chain = fallbackChain("primary", map);
    expect(chain).toHaveLength(3);
  });

  it("returns immutable (readonly) array", () => {
    const chain = fallbackChain("claude-sonnet-4-6", {});
    // TypeScript enforces readonly; at runtime verify it is a plain array
    expect(Array.isArray(chain)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// roleModelMapSchema validation
// ---------------------------------------------------------------------------

describe("roleModelMapSchema", () => {
  it("accepts an empty object", () => {
    expect(() => roleModelMapSchema.parse({})).not.toThrow();
  });

  it("accepts a fully-populated map", () => {
    const result = roleModelMapSchema.parse({
      architect: "claude-opus-4-5",
      editor: "claude-haiku-4-5",
      subagent: "claude-haiku-4-5",
    });
    expect(result).toEqual({
      architect: "claude-opus-4-5",
      editor: "claude-haiku-4-5",
      subagent: "claude-haiku-4-5",
    });
  });

  it("accepts a partial map (only architect)", () => {
    expect(() => roleModelMapSchema.parse({ architect: "claude-opus-4-5" })).not.toThrow();
  });

  it("rejects an empty string model id", () => {
    expect(() => roleModelMapSchema.parse({ architect: "" })).toThrow();
  });

  it("rejects a numeric model id", () => {
    expect(() => roleModelMapSchema.parse({ architect: 42 })).toThrow();
  });

  it("rejects unknown keys (strict mode)", () => {
    expect(() =>
      roleModelMapSchema.parse({ architect: "claude-opus-4-5", unknown_key: "x" }),
    ).toThrow();
  });

  it("accepts a provider-qualified target", () => {
    const result = roleModelMapSchema.parse({
      editor: { provider: "openai", model: "gpt-5.2" },
    });
    expect(result).toEqual({ editor: { provider: "openai", model: "gpt-5.2" } });
  });

  it("rejects an unknown provider name", () => {
    expect(() =>
      roleModelMapSchema.parse({ editor: { provider: "mystery", model: "m" } }),
    ).toThrow();
  });

  it("rejects a provider-qualified target without a model", () => {
    expect(() => roleModelMapSchema.parse({ editor: { provider: "openai" } })).toThrow();
  });

  it("rejects null values", () => {
    expect(() => roleModelMapSchema.parse({ editor: null })).toThrow();
  });

  it("rejects a non-object (array)", () => {
    expect(() => roleModelMapSchema.parse(["claude-opus-4-5"])).toThrow();
  });

  it("rejects a non-object (string)", () => {
    expect(() => roleModelMapSchema.parse("claude-opus-4-5")).toThrow();
  });
});
