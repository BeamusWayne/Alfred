/**
 * Tests for src/cli/session.ts front-door messages — fail with the next
 * command, not a stack trace.
 */

import { describe, expect, test } from "bun:test";
import { palette } from "../src/cli/colors.ts";
import { missingFeatureListMessage } from "../src/cli/session.ts";

const plain = palette({ isTTY: false });

describe("missingFeatureListMessage", () => {
  test("names the missing path relative to cwd and the next commands", () => {
    const msg = missingFeatureListMessage("/work/feature_list.json", "/work", plain);
    expect(msg).toContain("No feature list at feature_list.json");
    expect(msg).toContain("alfred init");
    expect(msg).toContain("--feature-list");
    expect(msg).toContain("alfred demo");
    expect(msg.endsWith("\n")).toBe(true);
  });

  test("keeps an explicit out-of-tree path legible", () => {
    const msg = missingFeatureListMessage("/elsewhere/list.json", "/work", plain);
    expect(msg).toContain("list.json");
  });
});
