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
 * Run `command` in a shell, capturing stdout/stderr/exitCode.
 * Enforces `timeoutMs` (kills the process and sets `timedOut: true`).
 * Honours `signal` for external cancellation.
 */
export async function runVerify(
  command: string,
  opts: VerifyOptions,
): Promise<VerifyResult> {
  const { cwd, timeoutMs, signal, env } = opts;
  const start = Date.now();

  const mergedEnv: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    ...env,
  };

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

  const readAll = async (
    stream: ReadableStream<Uint8Array>,
    chunks: Uint8Array[],
  ): Promise<void> => {
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
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

  // Give readers a chance to drain after the process exits / is killed.
  await readPromise.catch(() => {
    // Ignore read errors after kill.
  });

  if (timeoutHandle !== undefined) {
    clearTimeout(timeoutHandle);
  }

  if (signal) {
    signal.removeEventListener("abort", onAbort);
  }

  const decoder = new TextDecoder();
  const stdout = decoder.decode(
    mergeChunks(stdoutChunks),
  );
  const stderr = decoder.decode(
    mergeChunks(stderrChunks),
  );

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
