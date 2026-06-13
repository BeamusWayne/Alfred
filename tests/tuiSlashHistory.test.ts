/**
 * Slash menu state + prompt history navigation/persistence.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as hist from "../src/cli/tui/history.ts";
import { completion, menuActive, menuFor, moveSelection } from "../src/cli/tui/slash.ts";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "alfred-tui-hist-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("slash menu", () => {
  test("active only for a bare first token starting with /", () => {
    expect(menuActive("/he")).toBe(true);
    expect(menuActive("/model x")).toBe(false);
    expect(menuActive("hello")).toBe(false);
    expect(menuActive("/a\nb")).toBe(false);
  });

  test("filters by prefix and completes the selection", () => {
    const menu = menuFor("/c");
    expect(menu.matches.map((m) => m.name)).toEqual(["cost", "clear"]);
    expect(completion(menu)).toBe("/cost");
    expect(completion(moveSelection(menu, 1))).toBe("/clear");
  });

  test("selection survives narrowing when the command still matches", () => {
    const wide = moveSelection(menuFor("/c"), 1); // → clear
    const narrowed = menuFor("/cl", wide);
    expect(completion(narrowed)).toBe("/clear");
  });

  test("selection wraps both directions", () => {
    const menu = menuFor("/c");
    expect(moveSelection(menu, -1).selected).toBe(menu.matches.length - 1);
  });
});

describe("history", () => {
  test("up recalls newest first, down returns to the draft", () => {
    const entries = ["first", "second"];
    let nav = hist.startSession(entries, "");

    const up1 = hist.up(nav, "draft text");
    expect(up1?.text).toBe("second");
    nav = up1?.session ?? nav;

    const up2 = hist.up(nav, "second");
    expect(up2?.text).toBe("first");
    nav = up2?.session ?? nav;

    expect(hist.up(nav, "first")).toBeNull(); // top of history

    const down1 = hist.down(nav);
    expect(down1?.text).toBe("second");
    const down2 = hist.down(down1?.session ?? nav);
    expect(down2?.text).toBe("draft text"); // the captured draft comes back
  });

  test("push dedupes consecutive repeats", () => {
    const entries = hist.push(hist.push([], "same"), "same");
    expect(entries).toEqual(["same"]);
  });

  test("save/load round-trips multi-line prompts", async () => {
    const path = join(tmpDir, ".alfred", "history");
    await hist.saveHistory(path, ["one", "two\nlines"]);
    expect(hist.loadHistory(path)).toEqual(["one", "two\nlines"]);
  });

  test("a corrupt history file loads as empty, never throws", async () => {
    const path = join(tmpDir, ".alfred", "history-bad");
    await Bun.write(path, "not json\n{broken");
    expect(hist.loadHistory(path)).toEqual([]);
  });
});
