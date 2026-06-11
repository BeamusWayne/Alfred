/**
 * User-extensible model catalog (.alfred/models.json): partial entries merge
 * over the built-in catalog (same-key base) or the conservative default
 * (new prefixes); user entries win ties; invalid files warn and change
 * nothing.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearModelOverrides,
  modelProfile,
  registerModelOverrides,
} from "../src/config/modelCatalog.ts";
import { loadModelOverrides } from "../src/config/modelOverrides.ts";

afterEach(() => {
  clearModelOverrides();
});

describe("registerModelOverrides", () => {
  test("a new prefix gets the conservative default as its base", () => {
    registerModelOverrides({
      "gemini-3.1-pro": { contextWindow: 1_000_000, maxOutput: 65_536, tier: "frontier" },
    });
    const p = modelProfile("gemini-3.1-pro-preview");
    expect(p.contextWindow).toBe(1_000_000);
    expect(p.maxOutput).toBe(65_536);
    expect(p.tier).toBe("frontier");
    // Unset fields inherit the conservative default.
    expect(p.thinking).toBe("none");
    expect(p.supportsServerCompaction).toBe(false);
  });

  test("same key as a built-in entry: partial override, built-in base", () => {
    registerModelOverrides({ "claude-fable-5": { maxOutput: 32_000 } });
    const p = modelProfile("claude-fable-5");
    expect(p.maxOutput).toBe(32_000); // overridden
    expect(p.thinking).toBe("adaptive"); // inherited from the built-in entry
    expect(p.supportsTaskBudget).toBe(true);
  });

  test("without overrides the built-in catalog is untouched", () => {
    expect(modelProfile("claude-fable-5").maxOutput).toBe(128_000);
  });

  test("longest prefix still wins across both maps", () => {
    registerModelOverrides({ "gemini-": { tier: "small" } });
    // Built-in "gemini-2.5-pro" is longer than user "gemini-" → built-in wins.
    expect(modelProfile("gemini-2.5-pro").tier).toBe("strong");
    // Unknown 3.x id only matches the user prefix.
    expect(modelProfile("gemini-3.1-pro-preview").tier).toBe("small");
  });
});

describe("loadModelOverrides", () => {
  test("loads .alfred/models.json and applies it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alfred-overrides-"));
    await mkdir(join(dir, ".alfred"), { recursive: true });
    await writeFile(
      join(dir, ".alfred", "models.json"),
      JSON.stringify({ "my-internal-model": { contextWindow: 500_000, supportsEffort: true } }),
    );
    loadModelOverrides(dir);
    const p = modelProfile("my-internal-model-v2");
    expect(p.contextWindow).toBe(500_000);
    expect(p.supportsEffort).toBe(true);
  });

  test("missing file is a no-op; invalid file warns and changes nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alfred-overrides-"));
    loadModelOverrides(dir); // no .alfred/ at all — fine

    await mkdir(join(dir, ".alfred"), { recursive: true });
    await writeFile(join(dir, ".alfred", "models.json"), "{ not json");
    const warnings: string[] = [];
    loadModelOverrides(dir, (m) => warnings.push(m));
    expect(warnings).toHaveLength(1);
    expect(modelProfile("claude-fable-5").maxOutput).toBe(128_000);

    // Schema violations are also rejected, not partially applied.
    await writeFile(
      join(dir, ".alfred", "models.json"),
      JSON.stringify({ m: { contextWindow: -5 } }),
    );
    loadModelOverrides(dir, (m) => warnings.push(m));
    expect(warnings).toHaveLength(2);
  });
});
