/**
 * Provider setup for `alfred init` — endpoint, API key and default model
 * land in the project `.env`, which Bun auto-loads for every alfred
 * invocation from that directory (the config manager already reads these
 * variables; no new config machinery).
 *
 * Care points: the key is read with a masked prompt and never echoed or
 * printed back; the file is written chmod 0600 and `.env` is added to
 * `.gitignore`; empty answers keep existing values; Ctrl-C aborts without
 * touching anything. Pure pieces (env upsert, keystroke classifier,
 * gitignore) are exported for unit tests — IO is injected via `EnvSetupIo`.
 */
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { palette } from "./colors.ts";

// ---------------------------------------------------------------------------
// Pure: .env content
// ---------------------------------------------------------------------------

const ASSIGNMENT = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/;

/** Keys assigned anywhere in a .env file (plain or `export` form). */
export function envFileKeys(content: string): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const line of content.split("\n")) {
    const m = ASSIGNMENT.exec(line.trim());
    if (m?.[1] !== undefined) keys.add(m[1]);
  }
  return keys;
}

/**
 * Return new .env content with `updates` applied: existing assignments are
 * replaced in place (normalised to `KEY=value`), everything else is
 * preserved verbatim, missing keys are appended. Always newline-terminated.
 */
export function upsertEnvLines(
  existing: string | null,
  updates: Readonly<Record<string, string>>,
): string {
  const pending = new Map(Object.entries(updates));
  const lines = existing === null ? [] : existing.split("\n");
  // Drop a single trailing empty line so we can re-add the final newline.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const out = lines.map((line) => {
    const m = ASSIGNMENT.exec(line.trim());
    const key = m?.[1];
    if (key !== undefined && pending.has(key)) {
      const value = pending.get(key) as string;
      pending.delete(key);
      return `${key}=${value}`;
    }
    return line;
  });
  for (const [key, value] of pending) out.push(`${key}=${value}`);
  return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Pure: masked-input keystrokes
// ---------------------------------------------------------------------------

export type Keystroke =
  | { readonly kind: "append"; readonly text: string }
  | { readonly kind: "backspace" }
  | { readonly kind: "submit" }
  | { readonly kind: "abort" }
  | { readonly kind: "ignore" };

/** Classify one code point from a raw-mode stdin chunk. */
export function classifyKeystroke(ch: string): Keystroke {
  if (ch === "\r" || ch === "\n") return { kind: "submit" };
  if (ch === "\x7f" || ch === "\b") return { kind: "backspace" };
  if (ch === "\x03") return { kind: "abort" };
  // Other control characters (escape sequences, tabs, …) are not key text.
  if (ch < " ") return { kind: "ignore" };
  return { kind: "append", text: ch };
}

// ---------------------------------------------------------------------------
// Pure: .gitignore protection
// ---------------------------------------------------------------------------

const GITIGNORE_ENV_BLOCK = "# provider credentials (written by `alfred init`)\n.env\n";

/** New .gitignore content adding `.env`, or null when already covered. */
export function gitignoreWithEnv(existing: string | null): string | null {
  if (existing === null) return GITIGNORE_ENV_BLOCK;
  const hasEntry = existing.split("\n").some((line) => line.trim() === ".env");
  if (hasEntry) return null;
  const sep = existing.endsWith("\n") || existing === "" ? "" : "\n";
  return `${existing}${sep}\n${GITIGNORE_ENV_BLOCK}`;
}

// ---------------------------------------------------------------------------
// Interactive flow
// ---------------------------------------------------------------------------

export interface EnvSetupIo {
  /** Plain prompt; resolves null when the user aborts. */
  readonly ask: (prompt: string) => Promise<string | null>;
  /** Masked prompt for secrets; resolves null when the user aborts. */
  readonly askSecret: (prompt: string) => Promise<string | null>;
  readonly out: (line: string) => void;
}

interface SetupVar {
  readonly key: string;
  readonly hint: string;
  readonly secret: boolean;
}

const SETUP_VARS: readonly SetupVar[] = [
  {
    key: "ALFRED_BASE_URL",
    hint: "Anthropic-compatible endpoint; enter = official API (e.g. https://open.bigmodel.cn/api/anthropic for GLM)",
    secret: false,
  },
  {
    key: "ANTHROPIC_API_KEY",
    hint: "works for compatible endpoints too; input is hidden",
    secret: true,
  },
  {
    key: "ALFRED_MODEL",
    hint: "enter = claude-sonnet-4-6 (use e.g. glm-4.7 on GLM)",
    secret: false,
  },
];

/**
 * Ask for endpoint / key / model and persist non-empty answers to `.env`.
 * Never throws into init's flow: failures surface as printed warnings.
 */
export async function runEnvSetup(cwd: string, io: EnvSetupIo): Promise<void> {
  const c = palette(process.stderr);
  const envPath = join(cwd, ".env");
  const envFile = Bun.file(envPath);
  const existing = (await envFile.exists()) ? await envFile.text() : null;
  const present = existing === null ? new Set<string>() : envFileKeys(existing);

  io.out("");
  io.out(c.dim("provider setup — answers land in ./.env (chmod 600, gitignored); enter skips"));

  const updates: Record<string, string> = {};
  for (const spec of SETUP_VARS) {
    const configured = process.env[spec.key] !== undefined || present.has(spec.key);
    const state = configured ? "set — enter keeps it" : spec.hint;
    const answer = await (spec.secret ? io.askSecret : io.ask)(
      `  ${spec.key} ${c.dim(`(${state})`)}: `,
    );
    if (answer === null) {
      io.out(c.yellow("aborted — .env unchanged"));
      return;
    }
    const value = answer.trim();
    if (value === "") continue;
    if (spec.key === "ALFRED_BASE_URL" && !/^https?:\/\//.test(value)) {
      io.out(c.yellow(`  skipped: a base URL must start with http(s):// (got "${value}")`));
      continue;
    }
    updates[spec.key] = value;
  }

  const keys = Object.keys(updates);
  if (keys.length === 0) {
    io.out(c.dim("  nothing new — .env unchanged"));
    return;
  }

  await Bun.write(envPath, upsertEnvLines(existing, updates));
  await chmod(envPath, 0o600);

  // Keep credentials out of git wherever git is in play (same condition as
  // the .alfred/ entry in init).
  const gitignorePath = join(cwd, ".gitignore");
  const gitignoreFile = Bun.file(gitignorePath);
  const hasGitignore = await gitignoreFile.exists();
  const isRepo = await Bun.file(join(cwd, ".git", "HEAD")).exists();
  if (hasGitignore || isRepo) {
    const next = gitignoreWithEnv(hasGitignore ? await gitignoreFile.text() : null);
    if (next !== null) await Bun.write(gitignorePath, next);
  }

  io.out(`${c.green("✓")} .env written (0600): ${keys.join(", ")}`);
}

// ---------------------------------------------------------------------------
// Real terminal IO
// ---------------------------------------------------------------------------

/** Plain question on the TTY; Ctrl-C in cooked mode terminates the process. */
function plainQuestion(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    const onData = (buf: Buffer) => {
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolve(buf.toString("utf8").replace(/\r?\n$/, ""));
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

/** Masked question: raw mode, echo `*`, backspace edits, Ctrl-C aborts. */
function maskedQuestion(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setRawMode?.(true);
    stdin.resume();
    let value = "";
    const finish = (result: string | null): void => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      process.stderr.write("\n");
      resolve(result);
    };
    const onData = (buf: Buffer): void => {
      for (const ch of buf.toString("utf8")) {
        const action = classifyKeystroke(ch);
        if (action.kind === "append") {
          value += action.text;
          process.stderr.write("*");
        } else if (action.kind === "backspace" && value.length > 0) {
          value = value.slice(0, -1);
          process.stderr.write("\b \b");
        } else if (action.kind === "submit") {
          finish(value);
          return;
        } else if (action.kind === "abort") {
          finish(null);
          return;
        }
      }
    };
    stdin.on("data", onData);
  });
}

/** The real IO bundle, or null when there is no interactive terminal. */
export function terminalEnvSetupIo(): EnvSetupIo | null {
  if (process.stdin.isTTY !== true || process.stderr.isTTY !== true) return null;
  return {
    ask: plainQuestion,
    askSecret: maskedQuestion,
    out: (line) => process.stderr.write(`${line}\n`),
  };
}
