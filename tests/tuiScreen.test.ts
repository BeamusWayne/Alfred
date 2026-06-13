/**
 * Screen tests — the bottom-anchored repaint protocol over a fake stream:
 * paint, repaint-erase, scrollback insertion above the region, and visible
 * clipping that keeps one region line == one terminal row.
 */
import { describe, expect, test } from "bun:test";
import { clipVisible, Screen } from "../src/cli/tui/screen.ts";

function fake(columns = 40): { io: { write(s: string): void; columns: number }; out: () => string } {
  let buffer = "";
  return {
    io: {
      write(s: string) {
        buffer += s;
      },
      columns,
    },
    out: () => buffer,
  };
}

describe("Screen", () => {
  test("paint writes rows with autowrap disabled and parks the cursor", () => {
    const { io, out } = fake();
    const screen = new Screen(io);
    screen.paint({ lines: ["row1", "row2"], cursorRow: 0, cursorCol: 3 });

    const s = out();
    expect(s).toContain("\x1b[?7l"); // autowrap off
    expect(s).toContain("row1\nrow2");
    expect(s).toContain("\x1b[?7h"); // autowrap back on
    expect(s).toContain("\x1b[1A"); // cursor walked up to row 0
    expect(s).toContain("\x1b[3C"); // …and right to col 3
  });

  test("repaint erases exactly the painted region first", () => {
    const { io, out } = fake();
    const screen = new Screen(io);
    screen.paint({ lines: ["a", "b", "c"], cursorRow: 0, cursorCol: 0 });
    const before = out().length;
    screen.paint({ lines: ["x"], cursorRow: 0, cursorCol: 0 });

    const tail = out().slice(before);
    // Cursor was parked on region row 0 → no up-move needed, just CR + erase.
    expect(tail.startsWith("\r\x1b[0J")).toBe(true);
    expect(tail).toContain("x");
  });

  test("print inserts scrollback above and repaints the region after", () => {
    const { io, out } = fake();
    const screen = new Screen(io);
    screen.paint({ lines: ["region"], cursorRow: 0, cursorCol: 0 });
    const before = out().length;
    screen.print(["event line"], { lines: ["region"], cursorRow: 0, cursorCol: 0 });

    const tail = out().slice(before);
    const eventAt = tail.indexOf("event line\n");
    const regionAt = tail.lastIndexOf("region");
    expect(eventAt).toBeGreaterThan(-1);
    expect(regionAt).toBeGreaterThan(eventAt);
  });

  test("close erases the region and restores the cursor", () => {
    const { io, out } = fake();
    const screen = new Screen(io);
    screen.paint({ lines: ["row"], hideCursor: true });
    screen.close();
    const s = out();
    expect(s).toContain("\x1b[?25l"); // hidden during paint
    expect(s.endsWith("\x1b[?25h")).toBe(true); // restored at close
  });
});

describe("clipVisible", () => {
  test("keeps short lines untouched", () => {
    expect(clipVisible("short", 20)).toBe("short");
  });

  test("clips by display width, preserving ANSI and closing styles", () => {
    const line = `\x1b[2m${"x".repeat(50)}\x1b[0m`;
    const clipped = clipVisible(line, 20);
    expect(clipped.startsWith("\x1b[2m")).toBe(true);
    expect(clipped.endsWith("…\x1b[0m")).toBe(true);
    expect(clipped).not.toContain("x".repeat(30));
  });

  test("CJK counts double when clipping", () => {
    const clipped = clipVisible("你".repeat(30), 20);
    // 20 cols → at most 9 glyphs (18 cols) + ellipsis margin.
    expect((clipped.match(/你/g) ?? []).length).toBeLessThanOrEqual(9);
  });
});
