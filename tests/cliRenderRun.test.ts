/**
 * Tests for the human `alfred run` renderer (src/cli/renderRun.ts) — one
 * line per harness event, no color when the stream is not a TTY.
 */
import { describe, expect, test } from "bun:test";
import { palette } from "../src/cli/colors.ts";
import { renderAutonomousEvent } from "../src/cli/renderRun.ts";

const plain = palette({ isTTY: false });

describe("renderAutonomousEvent", () => {
  test("feature lifecycle renders one legible line per event", () => {
    expect(
      renderAutonomousEvent(
        {
          type: "feature_start",
          feature: { id: "f1", title: "Do the thing", description: "", status: "pending" },
        },
        plain,
      ),
    ).toBe("▸ f1  Do the thing");
    expect(renderAutonomousEvent({ type: "attempt", featureId: "f1", attempt: 2 }, plain)).toBe(
      "  attempt 2",
    );
    expect(
      renderAutonomousEvent(
        { type: "verify", featureId: "f1", attempt: 1, exitCode: 0, passed: true, gate: "full" },
        plain,
      ),
    ).toBe("  gate:full ✓ exit 0");
    expect(
      renderAutonomousEvent(
        { type: "verify", featureId: "f1", attempt: 1, exitCode: 1, passed: false, gate: "fast" },
        plain,
      ),
    ).toBe("  gate:fast ✗ exit 1");
    expect(renderAutonomousEvent({ type: "feature_passing", featureId: "f1" }, plain)).toBe(
      "✓ f1 passing",
    );
    expect(
      renderAutonomousEvent(
        { type: "feature_blocked", featureId: "f1", reason: "verify exit 1" },
        plain,
      ),
    ).toBe("✗ f1 blocked — verify exit 1");
    expect(
      renderAutonomousEvent(
        { type: "run_end", passing: 1, blocked: 0, stopped: "all_resolved" },
        plain,
      ),
    ).toBe("run end: 1 passing · 0 blocked · all_resolved");
  });
});
