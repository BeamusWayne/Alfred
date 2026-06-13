/**
 * Renderer tests — the input box (wrapping + exact cursor), slash menu,
 * approval panel, transcript formatters, and the streaming text flow.
 * Color is off (non-TTY palette) so assertions read plainly.
 */
import { describe, expect, test } from "bun:test";
import { palette } from "../src/cli/colors.ts";
import { fromText } from "../src/cli/tui/editor.ts";
import {
  renderApproval,
  renderBanner,
  renderInputBox,
  renderMenu,
  wrapVisible,
} from "../src/cli/tui/render.ts";
import { menuFor } from "../src/cli/tui/slash.ts";
import * as fmt from "../src/cli/tui/transcript.ts";

const c = palette({ isTTY: false });

describe("wrapVisible", () => {
  test("wraps by display width — CJK counts double", () => {
    expect(wrapVisible("abcdef", 4)).toEqual(["abcd", "ef"]);
    expect(wrapVisible("你好世界", 4)).toEqual(["你好", "世界"]);
    expect(wrapVisible("", 4)).toEqual([""]);
  });
});

describe("renderInputBox", () => {
  test("draws a rounded border with the prompt and places the cursor", () => {
    const box = renderInputBox(fromText("hi"), 40, c, "placeholder");
    expect(box.lines[0]).toBe(`╭${"─".repeat(38)}╮`);
    expect(box.lines[1]).toContain("> hi");
    expect(box.lines.at(-1)).toBe(`╰${"─".repeat(38)}╯`);
    expect(box.cursorRow).toBe(1);
    expect(box.cursorCol).toBe(2 + 2 + 2); // "│ " + "> " + "hi"
  });

  test("empty input shows the dim placeholder with the cursor at home", () => {
    const box = renderInputBox(fromText(""), 40, c, "ask alfred");
    expect(box.lines[1]).toContain("ask alfred");
    expect(box.cursorCol).toBe(4); // "│ " + "> "
  });

  test("long input wraps inside the border and the cursor follows", () => {
    const text = "a".repeat(50);
    const box = renderInputBox(fromText(text), 40, c, "");
    expect(box.lines.length).toBe(2 + 2); // border + two wrapped rows
    expect(box.cursorRow).toBe(2);
  });

  test("CJK cursor column counts double width", () => {
    const box = renderInputBox(fromText("你好"), 40, c, "");
    expect(box.cursorCol).toBe(2 + 2 + 4); // border+space, prompt, 2×2 cols
  });

  test("multi-line input renders one row per logical line", () => {
    const box = renderInputBox(fromText("a\nb"), 40, c, "");
    expect(box.lines.length).toBe(4);
    expect(box.cursorRow).toBe(2);
    expect(box.cursorCol).toBe(2 + 2 + 1);
  });
});

describe("slash menu rendering", () => {
  test("lists matches with the selection marked", () => {
    const menu = menuFor("/he");
    const rows = renderMenu(menu, 60, c);
    expect(rows.length).toBe(1);
    expect(rows[0]).toContain("❯ /help");
  });

  test("approval panel marks the selected row and shortcuts", () => {
    const rows = renderApproval(
      { toolName: "bash", description: "bash(rm -rf /tmp/x)", input: {} },
      1,
      80,
      c,
    );
    expect(rows[0]).toContain("approve bash(rm -rf /tmp/x)?");
    expect(rows[2]).toContain("❯ yes — always allow bash this session");
  });

  test("banner carries version, model, and cwd", () => {
    const rows = renderBanner(
      { version: "0.8.0", model: "m1", provider: "anthropic", cwd: "/tmp/x", mock: true },
      60,
      c,
    );
    expect(rows[1]).toContain("Alfred v0.8.0");
    expect(rows[2]).toContain("anthropic · m1");
    expect(rows[3]).toContain("/tmp/x");
  });
});

describe("transcript", () => {
  test("user echo dims and indents continuation lines", () => {
    expect(fmt.userEcho("a\nb", c)).toEqual(["> a", "  b"]);
  });

  test("tool result previews truncate with an honest marker", () => {
    const lines = fmt.toolResultLines("1\n2\n3\n4\n5\n6", false, c);
    expect(lines[0]).toBe("  ⎿ 1");
    expect(lines.at(-1)).toBe("    … +2 lines");
  });

  test("streaming flow: first visible line gets the ⏺ lead, tail flushes at end", () => {
    let step = fmt.pushDelta(fmt.EMPTY_FLOW, "Hello wor", c);
    expect(step.flushed).toEqual([]);
    expect(fmt.tailLine(step.flow, c)).toBe("⏺ Hello wor");

    step = fmt.pushDelta(step.flow, "ld\nsecond", c);
    expect(step.flushed).toEqual(["⏺ Hello world"]);
    expect(fmt.tailLine(step.flow, c)).toBe("  second");

    const end = fmt.endFlow(step.flow, c);
    expect(end.flushed).toEqual(["  second"]);
    expect(fmt.tailLine(end.flow, c)).toBeNull();
  });

  test("done line is silent on success, visible otherwise", () => {
    expect(fmt.doneLine("success", c)).toBeNull();
    expect(fmt.doneLine("max_turns", c)).toBe("[max_turns]");
  });
});
