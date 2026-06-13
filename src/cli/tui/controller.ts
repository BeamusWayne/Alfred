/**
 * The TUI controller — the living room the 0.3 REPL's porch grew into.
 *
 * One state machine over three modes:
 *   input    — the bordered editor + slash menu (Claude Code interaction
 *              grammar: ⏎ sends, \⏎ newline, / opens the menu, esc clears,
 *              ↑/↓ history, ctrl-c×2 quits)
 *   running  — a query streams; text flushes into scrollback line by line,
 *              tool beats render as ⏺/⎿, a spinner status line ticks at the
 *              bottom; esc or ctrl-c aborts truthfully (engine "aborted")
 *   approval — an "ask" tool call paused the run; ↑/↓ + ⏎ (or y/a/n) decide
 *
 * Everything the modes paint is pure (render.ts/transcript.ts); this file
 * owns ordering, the abort controller, lifecycle hooks, and history.
 */

import type { ConfigOverrides } from "../../config/manager.ts";
import { fireLifecycleHooks, firePromptHooks } from "../../hooks/lifecycle.ts";
import type { Message } from "../../providers/types.ts";
import { runQuery } from "../../query/engine.ts";
import type { ApprovalRequest } from "../../query/types.ts";
import { type Palette, palette } from "../colors.ts";
import { gatherDoctor, renderDoctor } from "../doctor.ts";
import {
  buildSession,
  closeSession,
  hookContext,
  keyPresent,
  mockActive,
  queryConfigFromSession,
  type Session,
} from "../session.ts";
import { gatherStatus, renderStatus } from "../status.ts";
import { VERSION } from "../../version.ts";
import { applyKey, EMPTY_EDITOR, type EditorState, fromText } from "./editor.ts";
import * as hist from "./history.ts";
import { type Key, KeyDecoder } from "./keys.ts";
import {
  APPROVAL_OPTIONS,
  renderApproval,
  renderBanner,
  renderHint,
  renderInputBox,
  renderMenu,
  renderStatus as renderSpinner,
} from "./render.ts";
import { type RegionPaint, Screen, type ScreenIo } from "./screen.ts";
import { menuActive, menuFor, type MenuState, moveSelection, completion } from "./slash.ts";
import * as fmt from "./transcript.ts";

const SPINNER_MS = 100;
const CTRL_C_WINDOW_MS = 2000;
const PLACEHOLDER = 'ask alfred — "/" for commands';

export interface TuiIo {
  readonly out: ScreenIo;
  readonly onResize?: (repaint: () => void) => void;
  readonly stdin: {
    on(event: "data", listener: (chunk: Buffer) => void): unknown;
    setRawMode?(mode: boolean): unknown;
  };
  readonly now: () => number;
  readonly setInterval: (fn: () => void, ms: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}

export interface TuiOptions {
  readonly yes?: boolean | undefined;
}

type Mode = "input" | "running" | "approval";

interface ApprovalWait {
  readonly req: ApprovalRequest;
  selected: number;
  readonly resolve: (ok: boolean) => void;
}

/** Build the real session + IO and run the loop (the `alfred` bare entry). */
export async function startTui(overrides: ConfigOverrides, opts: TuiOptions): Promise<number> {
  const session = await buildSession(overrides);
  const io: TuiIo = {
    out: process.stdout,
    onResize: (repaint) => process.stdout.on("resize", repaint),
    stdin: process.stdin,
    now: () => Date.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  };
  return runTui(session, opts, io);
}

/** The loop with injected deps — what the tests drive headlessly. */
export async function runTui(session: Session, opts: TuiOptions, io: TuiIo): Promise<number> {
  const screen = new Screen(io.out);
  const c = palette(io.out as { isTTY?: boolean });
  const hookCtx = hookContext(session);

  // --- mutable session state -----------------------------------------------
  let mode: Mode = "input";
  let editor: EditorState = EMPTY_EDITOR;
  let menu: MenuState = { matches: [], selected: 0 };
  let convo: readonly Message[] = [];
  let totalUsd = 0;
  let runUsd = 0;
  let modelOverride: string | undefined;
  let flow = fmt.EMPTY_FLOW;
  let spinnerTick = 0;
  let spinnerLabel = "Thinking";
  let runStarted = 0;
  let lastCtrlC = 0;
  let ctrlCHint = false;
  let approval: ApprovalWait | null = null;
  let abort: AbortController | null = null;
  let exitCode: number | null = null;
  const alwaysAllowed = new Set<string>();

  const historyPath = hist.historyPath(session.workingDir);
  let entries = hist.loadHistory(historyPath);
  let nav = hist.startSession(entries, "");

  const model = () => modelOverride ?? session.cfg.model;

  // --- painting -------------------------------------------------------------
  const inputRegion = (): RegionPaint => {
    const box = renderInputBox(editor, screen.columns, c, PLACEHOLDER);
    const below = menu.matches.length > 0
      ? renderMenu(menu, screen.columns, c)
      : [
          ctrlCHint
            ? c.dim("  (ctrl-c again to exit)")
            : renderHint(screen.columns, c, totalUsd, model()),
        ];
    return {
      lines: [...box.lines, ...below],
      cursorRow: box.cursorRow,
      cursorCol: box.cursorCol,
    };
  };

  const runningRegion = (): RegionPaint => {
    const tail = fmt.tailLine(flow, c);
    const status = renderSpinner(
      {
        tick: spinnerTick,
        label: spinnerLabel,
        startedMs: runStarted,
        nowMs: io.now(),
        costUsd: totalUsd + runUsd,
      },
      screen.columns,
      c,
    );
    return { lines: tail === null ? [status] : [tail, status], hideCursor: true };
  };

  const approvalRegion = (a: ApprovalWait): RegionPaint => ({
    lines: renderApproval(a.req, a.selected, screen.columns, c),
    hideCursor: true,
  });

  const repaint = (): void => {
    if (mode === "approval" && approval) screen.paint(approvalRegion(approval));
    else if (mode === "running") screen.paint(runningRegion());
    else screen.paint(inputRegion());
  };

  const print = (lines: readonly string[]): void => {
    if (mode === "approval" && approval) screen.print(lines, approvalRegion(approval));
    else if (mode === "running") screen.print(lines, runningRegion());
    else screen.print(lines, inputRegion());
  };

  // --- slash commands --------------------------------------------------------
  const runSlash = async (input: string): Promise<void> => {
    const [name = "", ...rest] = input.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (name) {
      case "exit":
      case "quit":
      case "q":
        exitCode = 0;
        return;
      case "help":
        print(helpLines(c));
        return;
      case "status": {
        const status = await gatherStatus(session.workingDir, {
          provider: session.cfg.provider,
          model: model(),
          keyPresent: keyPresent(session.cfg.provider),
          mockActive: mockActive(),
        });
        print(renderStatus(status, c).split("\n"));
        return;
      }
      case "doctor": {
        const checks = await gatherDoctor(session.workingDir, {
          provider: session.cfg.provider,
          model: model(),
        });
        print(renderDoctor(checks, c).split("\n"));
        return;
      }
      case "model":
        if (arg === "") {
          print([c.dim(`model: ${model()}${modelOverride ? " (session override)" : ""}`)]);
        } else {
          modelOverride = arg;
          print([c.dim(`model for this session → ${arg}`)]);
        }
        return;
      case "cost":
        print([c.dim(`session cost: $${totalUsd.toFixed(4)}`)]);
        return;
      case "clear":
        convo = [];
        print([c.dim("conversation history cleared")]);
        return;
      case "version":
        print([c.dim(`alfred v${VERSION}`)]);
        return;
      default:
        print([c.yellow(`unknown command /${name} — /help`)]);
    }
  };

  // --- approval ---------------------------------------------------------------
  const approve = async (req: ApprovalRequest): Promise<boolean> => {
    if (opts.yes) return true;
    if (alwaysAllowed.has(req.toolName)) return true;
    return new Promise<boolean>((resolve) => {
      approval = {
        req,
        selected: 0,
        resolve: (ok: boolean) => {
          approval = null;
          mode = "running";
          resolve(ok);
          repaint();
        },
      };
      mode = "approval";
      repaint();
    });
  };

  const decideApproval = (a: ApprovalWait, choice: number): void => {
    const what = APPROVAL_OPTIONS[choice] ?? "no";
    print([
      c.dim(
        `⚠ ${a.req.description} — ${what === "no" ? "denied" : what === "always" ? `allowed (always: ${a.req.toolName})` : "allowed"}`,
      ),
    ]);
    if (what === "always") alwaysAllowed.add(a.req.toolName);
    a.resolve(what !== "no");
  };

  // --- the run ------------------------------------------------------------------
  const runPrompt = async (prompt: string): Promise<void> => {
    entries = hist.push(entries, prompt);
    nav = hist.startSession(entries, "");
    void hist.saveHistory(historyPath, entries);

    mode = "running";
    flow = fmt.EMPTY_FLOW;
    runUsd = 0;
    runStarted = io.now();
    spinnerLabel = "Thinking";
    print(fmt.userEcho(prompt, c));

    const gate = await firePromptHooks(session.hooks, prompt, hookCtx);
    if (gate.block) {
      print([fmt.errorLine(`prompt blocked by hook: ${gate.reason}`, c)]);
      mode = "input";
      repaint();
      return;
    }

    abort = new AbortController();
    const spin = io.setInterval(() => {
      spinnerTick++;
      if (mode === "running") repaint();
    }, SPINNER_MS);

    try {
      const base = queryConfigFromSession(session);
      const gen = runQuery(prompt, {
        ...base,
        ...(modelOverride !== undefined ? { model: modelOverride } : {}),
        approve,
        signal: abort.signal,
        initialMessages: convo,
      });
      let step = await gen.next();
      while (!step.done) {
        const ev = step.value;
        if (ev.type === "text") {
          const d = fmt.pushDelta(flow, ev.text, c);
          flow = d.flow;
          if (d.flushed.length > 0) print([...d.flushed]);
          else repaint();
        } else if (ev.type === "tool_use") {
          const end = fmt.endFlow(flow, c);
          flow = end.flow;
          spinnerLabel = "Working";
          print([...end.flushed, fmt.toolUseLine(ev.describe, c)]);
        } else if (ev.type === "tool_result") {
          spinnerLabel = "Thinking";
          print([...fmt.toolResultLines(ev.output, ev.isError, c)]);
        } else if (ev.type === "retrying") {
          print([fmt.retryLine(ev.attempt, ev.delayMs, ev.reason, c)]);
        } else if (ev.type === "turn") {
          runUsd = ev.costUsd;
        } else if (ev.type === "error") {
          const end = fmt.endFlow(flow, c);
          flow = end.flow;
          print([...end.flushed, fmt.errorLine(ev.message, c)]);
        }
        step = await gen.next();
      }
      const state = step.value;
      const end = fmt.endFlow(flow, c);
      flow = end.flow;
      const done = fmt.doneLine(state.status, c);
      const tailLines = [...end.flushed, ...(done === null ? [] : [done])];
      if (tailLines.length > 0) print(tailLines);
      convo = state.messages;
      if (state.cost) totalUsd += state.cost.usd;
      await fireLifecycleHooks(session.hooks, "Stop", hookCtx);
    } catch (err) {
      print([fmt.errorLine(err instanceof Error ? err.message : String(err), c)]);
    } finally {
      io.clearInterval(spin);
      abort = null;
      mode = "input";
      repaint();
    }
  };

  // --- key routing -----------------------------------------------------------------
  const handleKey = (key: Key): void => {
    if (exitCode !== null) return;

    if (mode === "approval" && approval) {
      const a = approval;
      const shortcut =
        key.type === "enter"
          ? a.selected
          : key.type === "escape" || key.type === "ctrl-c"
            ? 2
            : key.type === "char"
              ? { y: 0, a: 1, n: 2 }[key.char.toLowerCase()]
              : undefined;
      if (shortcut !== undefined) {
        decideApproval(a, shortcut);
        return;
      }
      if (key.type === "up") a.selected = (a.selected + 2) % 3;
      else if (key.type === "down" || key.type === "tab") a.selected = (a.selected + 1) % 3;
      repaint();
      return;
    }

    if (mode === "running") {
      if (key.type === "escape" || key.type === "ctrl-c") abort?.abort();
      return;
    }

    // --- input mode ---
    ctrlCHint = false;

    // The slash menu captures navigation/completion keys while open.
    if (menu.matches.length > 0) {
      if (key.type === "up" || key.type === "shift-tab") {
        menu = moveSelection(menu, -1);
        repaint();
        return;
      }
      if (key.type === "down") {
        menu = moveSelection(menu, 1);
        repaint();
        return;
      }
      if (key.type === "tab") {
        const text = completion(menu);
        if (text !== null) editor = fromText(text);
        menu = menuFor(editor.text, menu);
        repaint();
        return;
      }
      if (key.type === "enter") {
        const text = completion(menu);
        editor = EMPTY_EDITOR;
        menu = { matches: [], selected: 0 };
        if (text !== null) {
          print(fmt.userEcho(text, c));
          void runSlash(text).then(repaint);
        }
        return;
      }
    }

    const step = applyKey(editor, key);
    editor = step.state;
    menu = menuActive(editor.text) ? menuFor(editor.text, menu) : { matches: [], selected: 0 };

    const effect = step.effect;
    if (!effect) {
      repaint();
      return;
    }

    switch (effect.kind) {
      case "submit": {
        menu = { matches: [], selected: 0 };
        if (effect.text.startsWith("/")) {
          print(fmt.userEcho(effect.text, c));
          entries = hist.push(entries, effect.text);
          nav = hist.startSession(entries, "");
          void hist.saveHistory(historyPath, entries);
          void runSlash(effect.text).then(repaint);
        } else {
          void runPrompt(effect.text);
        }
        return;
      }
      case "history-up": {
        const r = hist.up(nav, editor.text);
        if (r) {
          nav = r.session;
          editor = fromText(r.text);
          menu = { matches: [], selected: 0 };
        }
        repaint();
        return;
      }
      case "history-down": {
        const r = hist.down(nav);
        if (r) {
          nav = r.session;
          editor = fromText(r.text);
          menu = { matches: [], selected: 0 };
        }
        repaint();
        return;
      }
      case "escape":
        menu = { matches: [], selected: 0 };
        repaint();
        return;
      case "exit":
        exitCode = 0;
        return;
      case "interrupt": {
        if (editor.text !== "") {
          editor = EMPTY_EDITOR;
          menu = { matches: [], selected: 0 };
          repaint();
          return;
        }
        const now = io.now();
        if (now - lastCtrlC < CTRL_C_WINDOW_MS) {
          exitCode = 0;
          return;
        }
        lastCtrlC = now;
        ctrlCHint = true;
        repaint();
        return;
      }
      case "redraw":
        repaint();
        return;
    }
  };

  // --- boot --------------------------------------------------------------------------
  io.stdin.setRawMode?.(true);
  io.out.write("\x1b[?2004h"); // bracketed paste
  const decoder = new KeyDecoder(handleKey);
  io.stdin.on("data", (chunk: Buffer) => decoder.feed(chunk));
  io.onResize?.(repaint);

  await fireLifecycleHooks(session.hooks, "SessionStart", hookCtx, "repl");
  const banner = renderBanner(
    {
      version: VERSION,
      model: model(),
      provider: session.cfg.provider,
      cwd: session.workingDir,
      mock: mockActive(),
    },
    screen.columns,
    c,
  );
  screen.print([...banner, ""], inputRegion());

  // Park until something sets the exit code, then tear down in order.
  await new Promise<void>((resolve) => {
    const tick = io.setInterval(() => {
      if (exitCode !== null) {
        io.clearInterval(tick);
        resolve();
      }
    }, 30);
  });

  screen.close();
  io.out.write("\x1b[?2004l");
  io.stdin.setRawMode?.(false);
  await fireLifecycleHooks(session.hooks, "SessionEnd", hookCtx, "exit");
  await closeSession(session);
  io.out.write(c.dim(`session cost: $${totalUsd.toFixed(4)}\n`));
  return exitCode ?? 0;
}

function helpLines(c: Palette): readonly string[] {
  return [
    c.bold("commands"),
    "  /help /status /model [name] /cost /doctor /clear /version /exit",
    c.bold("keys"),
    `  ${c.dim("⏎ send · \\⏎ or ctrl-j newline · ↑/↓ history · esc clear input")}`,
    `  ${c.dim("esc or ctrl-c interrupt a run · ctrl-c ×2 quit · ctrl-a/e home/end · ctrl-w/u/k kill")}`,
  ];
}
