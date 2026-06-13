/**
 * Controller integration — the whole TUI loop driven headlessly: a fake
 * stdin feeds bytes through the real KeyDecoder, a scripted MockProvider
 * answers, and assertions read the raw ANSI stream a terminal would get.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/manager.ts";
import { MockProvider, textResponse } from "../src/providers/mock.ts";
import type { Session } from "../src/cli/session.ts";
import { runTui, type TuiIo } from "../src/cli/tui/controller.ts";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "alfred-tui-ctrl-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function fakeSession(dir: string): Session {
  return {
    cfg: loadConfig({}),
    provider: new MockProvider([() => textResponse("hello from alfred")]),
    systemPrompt: "test system prompt",
    hooks: { hooks: [] },
    memory: undefined,
    ext: { tools: [], warnings: [], close: async () => {} },
    tools: undefined,
    workingDir: dir,
    sessionId: "tui-test-session",
  };
}

interface Harness {
  readonly io: TuiIo;
  feed(bytes: string): void;
  output(): string;
}

function harness(): Harness {
  let listener: ((chunk: Buffer) => void) | null = null;
  let buffer = "";
  const io: TuiIo = {
    out: {
      write(s: string) {
        buffer += s;
      },
      columns: 80,
    },
    stdin: {
      on(_event, fn) {
        listener = fn;
        return undefined;
      },
    },
    now: () => Date.now(),
    // Compress all timers so the loop ticks fast under test.
    setInterval: (fn, ms) => setInterval(fn, Math.min(ms, 5)),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  };
  return {
    io,
    feed: (bytes: string) => listener?.(Buffer.from(bytes)),
    output: () => buffer,
  };
}

async function until(predicate: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("runTui", () => {
  test("prompt → streamed answer → /exit, with history persisted", async () => {
    const dir = mkdtempSync(join(tmpDir, "round-"));
    const h = harness();
    const done = runTui(fakeSession(dir), {}, h.io);

    await until(() => h.output().includes("Alfred v"), "banner");
    h.feed("hi alfred\r");
    await until(() => h.output().includes("hello from alfred"), "answer");

    // The submitted prompt echoed into scrollback; the answer leads with ⏺.
    expect(h.output()).toContain("> hi alfred");
    expect(h.output()).toContain("⏺ hello from alfred");

    h.feed("/exit\r");
    expect(await done).toBe(0);
    expect(h.output()).toContain("session cost:");

    const history = await Bun.file(join(dir, ".alfred", "history")).text();
    expect(history).toContain(JSON.stringify("hi alfred"));
  });

  test("slash menu: /he + enter completes to /help and prints commands", async () => {
    const dir = mkdtempSync(join(tmpDir, "slash-"));
    const h = harness();
    const done = runTui(fakeSession(dir), {}, h.io);

    await until(() => h.output().includes("Alfred v"), "banner");
    h.feed("/he");
    await until(() => h.output().includes("❯ /help"), "menu row");
    h.feed("\r");
    await until(() => h.output().includes("/model [name]"), "help body");

    h.feed("\x04"); // ctrl-d on empty input exits
    expect(await done).toBe(0);
  });

  test("ctrl-c twice quits; once only hints", async () => {
    const dir = mkdtempSync(join(tmpDir, "ctrlc-"));
    const h = harness();
    const done = runTui(fakeSession(dir), {}, h.io);

    await until(() => h.output().includes("Alfred v"), "banner");
    h.feed("\x03");
    await until(() => h.output().includes("ctrl-c again to exit"), "hint");
    h.feed("\x03");
    expect(await done).toBe(0);
  });

  test("ctrl-c with a draft clears the input instead of quitting", async () => {
    const dir = mkdtempSync(join(tmpDir, "draft-"));
    const h = harness();
    const done = runTui(fakeSession(dir), {}, h.io);

    await until(() => h.output().includes("Alfred v"), "banner");
    h.feed("draft text");
    await until(() => h.output().includes("draft text"), "draft rendered");
    h.feed("\x03"); // clears the draft, no exit
    h.feed("/exit\r");
    expect(await done).toBe(0);
  });

  test("/model switches the session model label", async () => {
    const dir = mkdtempSync(join(tmpDir, "model-"));
    const h = harness();
    const done = runTui(fakeSession(dir), {}, h.io);

    await until(() => h.output().includes("Alfred v"), "banner");
    h.feed("/model my-model-x\r");
    await until(() => h.output().includes("model for this session → my-model-x"), "model set");

    h.feed("/exit\r");
    expect(await done).toBe(0);
  });
});
