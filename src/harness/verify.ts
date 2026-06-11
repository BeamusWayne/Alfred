/**
 * Objective verify gate — ADR 0001 §7.7 (objective verify gate)
 *
 * "Done" is machine-enforced: run a real command and trust only its exit code.
 * No LLM self-report can mark a feature passing; this function is that gate.
 */

export interface VerifyResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

export interface VerifyOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly env?: Record<string, string>;
}

/**
 * Env var names that must NEVER reach the verify subprocess. The verify command
 * is model-influenced (e.g. `bun test` runs repo test files the agent just
 * wrote) and is not sandboxed, so any secret in its env is exfiltratable.
 * Above all this strips ALFRED_LEDGER_SECRET — the key that signs the
 * tamper-evident ledger; leaking it would let a malicious run forge the Proof
 * Receipt — plus provider API credentials (ADR 0003 blast-radius reduction).
 */
const SENSITIVE_ENV_RE = /(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|API[_-]?KEY|ACCESS[_-]?KEY)/i;

/** Max time to wait for the output pipes to drain after the process exits/dies. */
const DRAIN_GRACE_MS = 2000;

/**
 * Run `command` in a shell, capturing stdout/stderr/exitCode.
 * Enforces `timeoutMs` (kills the process and sets `timedOut: true`).
 * Honours `signal` for external cancellation.
 */
export async function runVerify(command: string, opts: VerifyOptions): Promise<VerifyResult> {
  const { cwd, timeoutMs, signal, env } = opts;
  const start = Date.now();

  // Strip Alfred's own secrets + provider credentials from the inherited env
  // before handing it to the (unsandboxed, model-influenced) verify command.
  // An explicit, trusted `opts.env` may still set anything it needs.
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !SENSITIVE_ENV_RE.test(entry[0]),
    ),
  );
  const mergedEnv: Record<string, string> = { ...inheritedEnv, ...env };

  const proc = Bun.spawn(["sh", "-c", command], {
    cwd,
    env: mergedEnv,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise =
    timeoutMs !== undefined
      ? new Promise<void>((resolve) => {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            proc.kill();
            resolve();
          }, timeoutMs);
        })
      : null;

  const onAbort = (): void => {
    proc.kill();
  };
  if (signal) {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  // Minimal structural type — we only ever cancel these; avoids a clash between
  // the global and node:stream/web ReadableStreamDefaultReader definitions.
  const readers: Array<{ cancel(): Promise<unknown> }> = [];

  const readAll = async (
    stream: ReadableStream<Uint8Array>,
    chunks: Uint8Array[],
  ): Promise<void> => {
    const reader = stream.getReader();
    readers.push(reader);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    } catch {
      // reader cancelled or stream errored after kill — stop draining.
    }
  };

  const readPromise = Promise.all([
    readAll(proc.stdout, stdoutChunks),
    readAll(proc.stderr, stderrChunks),
  ]);

  if (timeoutPromise !== null) {
    await Promise.race([proc.exited, timeoutPromise]);
  } else {
    await proc.exited;
  }

  // Bound the post-exit drain. Killing the shell does not kill its children, so
  // a leaked grandchild can keep the stdout/stderr pipe open — the readers would
  // then await `done` forever and runVerify would hang far past timeoutMs. Give
  // a short grace, then cancel the readers so the drain always terminates.
  await Promise.race([
    readPromise,
    new Promise<void>((resolve) => setTimeout(resolve, DRAIN_GRACE_MS)),
  ]);
  for (const reader of readers) {
    void reader.cancel().catch(() => undefined);
  }
  await readPromise.catch(() => undefined);

  if (timeoutHandle !== undefined) {
    clearTimeout(timeoutHandle);
  }

  if (signal) {
    signal.removeEventListener("abort", onAbort);
  }

  const decoder = new TextDecoder();
  const stdout = decoder.decode(mergeChunks(stdoutChunks));
  const stderr = decoder.decode(mergeChunks(stderrChunks));

  const exitCode = timedOut ? 1 : (proc.exitCode ?? 1);
  const durationMs = Date.now() - start;

  return { exitCode, stdout, stderr, durationMs, timedOut };
}

/** Returns true only when the command exited cleanly (exit 0, no timeout). */
export function passed(result: VerifyResult): boolean {
  return result.exitCode === 0 && !result.timedOut;
}

function mergeChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
