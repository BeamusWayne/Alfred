import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PROFILE,
  defaultEffortForRole,
  defaultMaxTokens,
  modelProfile,
} from "../src/config/modelCatalog.ts";

describe("modelProfile", () => {
  test("resolves Fable 5 to the frontier profile (no sampling params, adaptive thinking)", () => {
    const p = modelProfile("claude-fable-5");
    expect(p.contextWindow).toBe(1_000_000);
    expect(p.maxOutput).toBe(128_000);
    expect(p.thinking).toBe("adaptive");
    expect(p.supportsTemperature).toBe(false);
    expect(p.supportsEffort).toBe(true);
    expect(p.supportsTaskBudget).toBe(true);
    expect(p.tier).toBe("frontier");
  });

  test("longest-prefix match handles date-suffixed ids", () => {
    expect(modelProfile("claude-opus-4-5-20251101").maxOutput).toBe(64_000);
    expect(modelProfile("claude-haiku-4-5-20251001").tier).toBe("small");
  });

  test("opus 4.6 keeps temperature support; 4.7+ drops it", () => {
    expect(modelProfile("claude-opus-4-6").supportsTemperature).toBe(true);
    expect(modelProfile("claude-opus-4-7").supportsTemperature).toBe(false);
    expect(modelProfile("claude-opus-4-8").supportsTemperature).toBe(false);
  });

  test("GLM via the Anthropic-compatible endpoint never gets thinking/effort", () => {
    const p = modelProfile("glm-4.6");
    expect(p.thinking).toBe("none");
    expect(p.supportsEffort).toBe(false);
  });

  test("unknown models get the conservative default", () => {
    expect(modelProfile("totally-new-model")).toBe(DEFAULT_PROFILE);
    expect(DEFAULT_PROFILE.thinking).toBe("none");
    expect(DEFAULT_PROFILE.contextWindow).toBe(128_000);
  });
});

describe("defaultMaxTokens", () => {
  test("streaming gets 64K headroom, non-streaming stays under SDK timeouts", () => {
    const fable = modelProfile("claude-fable-5");
    expect(defaultMaxTokens(fable, true)).toBe(64_000);
    expect(defaultMaxTokens(fable, false)).toBe(16_000);
  });

  test("always capped by the model's own ceiling", () => {
    const glm = modelProfile("glm-4.6");
    expect(defaultMaxTokens(glm, true)).toBe(8_192);
    expect(defaultMaxTokens(glm, false)).toBe(8_192);
  });
});

describe("defaultEffortForRole", () => {
  test("architect thinks hardest, subagents stay cheap", () => {
    expect(defaultEffortForRole("architect")).toBe("xhigh");
    expect(defaultEffortForRole("editor")).toBe("medium");
    expect(defaultEffortForRole("subagent")).toBe("low");
    expect(defaultEffortForRole(undefined)).toBeUndefined();
  });
});
