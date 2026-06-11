/**
 * Tests for the multi-line sticky footer (src/cli/footer.ts) — the live-panel
 * face shared by `alfred run` and `alfred watch`. Event lines scroll normally;
 * the footer redraws in place via cursor-up + erase-below. No alternate
 * screen, scrollback survives.
 */

import { describe, expect, test } from "bun:test";
import {
  type FooterIo,
  formatElapsed,
  progressBar,
  renderFooterLines,
  StickyFooter,
  truncateVisible,
} from "../src/cli/footer.ts";

describe("progressBar", () => {
  test("scales resolved/total to ten cells", () => {
    expect(progressBar(0, 10)).toBe("▯▯▯▯▯▯▯▯▯▯");
    expect(progressBar(5, 10)).toBe("▮▮▮▮▮▯▯▯▯▯");
    expect(progressBar(10, 10)).toBe("▮▮▮▮▮▮▮▮▮▮");
    expect(progressBar(1, 3)).toBe("▮▮▮▯▯▯▯▯▯▯");
  });

  test("unknown total renders an empty track", () => {
    expect(progressBar(2, null)).toBe("▯▯▯▯▯▯▯▯▯▯");
  });
});

describe("formatElapsed", () => {
  test("renders m:ss and h:mm:ss", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(134_000)).toBe("2:14");
    expect(formatElapsed(3_725_000)).toBe("1:02:05");
  });
});

describe("renderFooterLines", () => {
  test("head line carries bar, counts, elapsed and spend", () => {
    const lines = renderFooterLines({
      resolved: 1,
      total: 3,
      costUsd: 0.0212,
      elapsedMs: 134_000,
    });
    expect(lines[0]).toBe("▮▮▮▯▯▯▯▯▯▯ 1/3 features · ⏱ 2:14 · $0.0212");
    expect(lines.length).toBe(1);
  });

  test("adds a current-action line when one is known", () => {
    const lines = renderFooterLines({
      resolved: 0,
      total: null,
      costUsd: 0,
      elapsedMs: 0,
      current: "implement:auth#2 · bash(bun test)",
    });
    expect(lines[0]).toBe("▯▯▯▯▯▯▯▯▯▯ 0 features · ⏱ 0:00 · $0.0000");
    expect(lines[1]).toBe("▸ implement:auth#2 · bash(bun test)");
  });
});

describe("truncateVisible", () => {
  test("leaves short lines alone and ellipsizes long ones", () => {
    expect(truncateVisible("short", 10)).toBe("short");
    expect(truncateVisible("a".repeat(12), 10)).toBe(`${"a".repeat(9)}…`);
  });
});

describe("StickyFooter", () => {
  function fakeIo(columns?: number): FooterIo & { readonly chunks: string[] } {
    const chunks: string[] = [];
    return { chunks, columns, write: (s: string) => chunks.push(s) };
  }

  test("first draw writes events then footer; redraw erases the old footer", () => {
    const io = fakeIo(80);
    const footer = new StickyFooter(io, true, (s) => s);

    footer.print(["e1"], ["f1", "f2"]);
    expect(io.chunks).toEqual(["e1\n", "f1\n", "f2\n"]);

    footer.print(["e2"], ["f1'"]);
    expect(io.chunks.slice(3)).toEqual(["\x1b[2A\x1b[0J", "e2\n", "f1'\n"]);
  });

  test("clear erases the footer once and is idempotent", () => {
    const io = fakeIo(80);
    const footer = new StickyFooter(io, true, (s) => s);
    footer.print([], ["f1"]);
    footer.clear();
    footer.clear();
    expect(io.chunks).toEqual(["f1\n", "\x1b[1A\x1b[0J"]);
  });

  test("disabled mode passes events through and drops the footer", () => {
    const io = fakeIo();
    const footer = new StickyFooter(io, false, (s) => s);
    footer.print(["e1"], ["f1"]);
    footer.clear();
    expect(io.chunks).toEqual(["e1\n"]);
  });

  test("footer lines are truncated to the terminal width", () => {
    const io = fakeIo(24);
    const footer = new StickyFooter(io, true, (s) => s);
    footer.print([], ["x".repeat(40)]);
    expect(io.chunks[0]).toBe(`${"x".repeat(22)}…\n`);
  });
});
