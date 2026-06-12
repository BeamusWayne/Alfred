/**
 * Hooks engine — ADR 0001 §7.5 (hooks, exit-2-blocks)
 *
 * Loads user hook configuration and runs matching shell commands around tool
 * calls. A hook receives a JSON payload on stdin and communicates back via:
 *   - exit 2          → block the tool (PreToolUse only); stderr = reason.
 *   - stdout JSON     → `{"updatedInput":{…}}` rewrites the tool input.
 *   - exit 0          → allow, no rewrite.
 *   - any other exit  → allow, lenient (hook errors must not crash Alfred).
 *
 * PostToolUse hooks are observe-only: exit 2 is silently ignored.
 */

import { readFileSync } from "node:fs";
import { buildHookPayload, type HookFireInput } from "./payload.ts";
import type { HookContext, HookEvent, HookMatcher, HookOutcome, HooksConfig } from "./types.ts";
import { BLOCKING_EVENTS, hooksConfigSchema } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

/**
 * Read and validate a hooks config JSON file.
 * A missing file is treated as an empty config (no hooks).
 * A malformed file throws a descriptive error.
 */
export async function loadHooksConfig(path: string): Promise<HooksConfig> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err: unknown) {
    // ENOENT → no config, that is fine.
    if (isNodeError(err) && err.code === "ENOENT") {
      return { hooks: [] };
    }
    throw new Error(`hooks: cannot read config at ${path}: ${String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`hooks: config at ${path} is not valid JSON`);
  }

  const result = hooksConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`hooks: config at ${path} failed validation: ${result.error.message}`);
  }

  return result.data;
}

// ---------------------------------------------------------------------------
// Core runner
// ---------------------------------------------------------------------------

/**
 * Run all matching hooks for `event` (+ tool name on tool events).
 *
 * Hooks run sequentially. On blocking events (PreToolUse, UserPromptSubmit)
 * the first hook that exits 2 wins and short-circuits remaining hooks; on
 * every other event exit-2 is observe-only. `updatedInput` accumulates across
 * passing hooks (last writer wins per key).
 */
export async function runHooks(
  config: HooksConfig,
  event: HookEvent,
  payload: HookFireInput,
  opts?: { readonly cwd?: string; readonly context?: Partial<HookContext> },
): Promise<HookOutcome> {
  // Lifecycle events have no tool name; treat them as matched by wildcard
  // matchers only (an exact toolPattern on SessionStart never fires).
  const matchers = config.hooks.filter(
    (m) => m.event === event && matchesTool(m, payload.toolName ?? ""),
  );

  if (matchers.length === 0) {
    return { block: false };
  }

  // Carry the accumulated input forward so each hook sees the latest version.
  let currentInput = payload.input;
  let mergedUpdatedInput: Record<string, unknown> | undefined;

  for (const matcher of matchers) {
    const stdinPayload = buildHookPayload(
      event,
      { ...payload, input: currentInput },
      { ...opts?.context, cwd: opts?.context?.cwd ?? opts?.cwd },
    );

    const outcome = await runSingleHook(matcher, stdinPayload, opts?.cwd);

    if (outcome.block) {
      // Exit-2 only blocks on blocking events; elsewhere it is observe-only.
      if (!BLOCKING_EVENTS.has(event)) {
        continue;
      }
      return { block: true, reason: outcome.reason };
    }

    if (outcome.updatedInput !== undefined) {
      // Merge rewrite into accumulated state.
      mergedUpdatedInput = { ...mergedUpdatedInput, ...outcome.updatedInput };
      currentInput = { ...(currentInput ?? {}), ...outcome.updatedInput };
    }
  }

  return { block: false, updatedInput: mergedUpdatedInput };
}

// ---------------------------------------------------------------------------
// Single-hook execution
// ---------------------------------------------------------------------------

interface SingleOutcome {
  readonly block: boolean;
  readonly reason?: string;
  readonly updatedInput?: Record<string, unknown>;
}

async function runSingleHook(
  matcher: HookMatcher,
  stdinPayload: string,
  cwd?: string,
): Promise<SingleOutcome> {
  const timeoutMs = matcher.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const proc = Bun.spawn(["sh", "-c", matcher.command], {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Write JSON payload to stdin then close the FileSink.
    proc.stdin.write(stdinPayload);
    proc.stdin.end();

    // Enforce timeout — kill the process if it lingers.
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    // Collect stdout and stderr concurrently with exit. Using Bun's Response
    // helper which drains the stream reliably, even after process death.
    const [exitedVoid, stdoutText, stderrText] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text().catch(() => ""),
      new Response(proc.stderr).text().catch(() => ""),
    ]);
    void exitedVoid;

    clearTimeout(timeoutHandle);

    const stdout = stdoutText.trim();
    const stderr = stderrText.trim();
    const exitCode = timedOut ? 1 : (proc.exitCode ?? 1);

    // Timed-out → lenient allow (hook was too slow).
    if (timedOut) {
      return { block: false };
    }

    // exit 2 → block (caller decides whether to honour based on event type).
    if (exitCode === 2) {
      return { block: true, reason: stderr || "hook blocked the tool call" };
    }

    // Non-zero, non-2 → lenient allow; the hook had an internal error.
    if (exitCode !== 0) {
      return { block: false };
    }

    // exit 0 → parse optional stdout rewrite.
    const updatedInput = parseUpdatedInput(stdout);
    return { block: false, updatedInput };
  } catch (err: unknown) {
    // A crashing hook must never crash Alfred — treat as lenient allow.
    void err; // acknowledged
    return { block: false };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the matcher's toolPattern covers `toolName`.
 * `"*"` or absent → all tools; any other value → exact string match.
 */
function matchesTool(matcher: HookMatcher, toolName: string): boolean {
  const pat = matcher.toolPattern;
  if (pat === undefined || pat === "*") return true;
  return pat === toolName;
}

/**
 * Attempt to parse `{"updatedInput":{…}}` from hook stdout.
 * Returns undefined on any parse failure (lenient).
 */
function parseUpdatedInput(stdout: string): Record<string, unknown> | undefined {
  if (stdout === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "updatedInput" in parsed
    ) {
      const candidate = (parsed as Record<string, unknown>)["updatedInput"];
      if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
        return candidate as Record<string, unknown>;
      }
    }
  } catch {
    // Malformed stdout — ignore silently.
  }
  return undefined;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
