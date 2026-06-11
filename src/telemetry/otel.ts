/**
 * Zero-dependency OTel GenAI tracing layer — ADR 0004.
 *
 * Emits spans shaped to the OpenTelemetry GenAI semantic conventions so any
 * backend (Datadog / Honeycomb / Langfuse) can render them without bespoke
 * adapters. Exporters are opt-in; the default is a no-op so production builds
 * pay no I/O cost unless ALFRED_OTEL_FILE is set.
 *
 * Design principles:
 *   - Pure immutable data: spans are plain readonly objects, never mutated.
 *   - No Math.random / Date.now at module level — all sources of non-determinism
 *     are injectable so tests are fully deterministic.
 *   - No external dependencies; the FileExporter is a tiny JSONL serialiser.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Attribute key constants (OTel GenAI semantic conventions)
// ---------------------------------------------------------------------------

export const GEN_AI_OPERATION_NAME = "gen_ai.operation.name" as const;
export const GEN_AI_SYSTEM = "gen_ai.system" as const;
export const GEN_AI_REQUEST_MODEL = "gen_ai.request.model" as const;
export const GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens" as const;
export const GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens" as const;
export const GEN_AI_TOOL_NAME = "gen_ai.tool.name" as const;

export type GenAiOperationName = "chat" | "execute_tool" | "invoke_agent";

// ---------------------------------------------------------------------------
// Core span data type
// ---------------------------------------------------------------------------

export interface Span {
  readonly name: string;
  readonly spanId: string;
  readonly parentId?: string;
  readonly startTime: number;
  readonly endTime?: number;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  readonly status: "ok" | "error" | "unset";
}

// ---------------------------------------------------------------------------
// Exporter interface
// ---------------------------------------------------------------------------

export interface SpanExporter {
  export(span: Span): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// NoopExporter — zero cost when telemetry is disabled
// ---------------------------------------------------------------------------

export class NoopExporter implements SpanExporter {
  export(_span: Span): void {
    // intentional no-op
  }
}

// ---------------------------------------------------------------------------
// FileExporter — writes completed spans as OTLP-style JSONL
// ---------------------------------------------------------------------------

export class FileExporter implements SpanExporter {
  private readonly path: string;
  private dirReady = false;

  constructor(path: string) {
    this.path = path;
  }

  /**
   * Append the span synchronously. Synchronous I/O is deliberate: spans are
   * small and infrequent, and a sync append guarantees every span — including
   * the last one, ended just before `process.exit` — actually lands on disk.
   * An async write queue races the exit and silently drops the final span.
   */
  export(span: Span): void {
    if (!this.dirReady) {
      try {
        mkdirSync(dirname(this.path), { recursive: true });
      } catch {
        // parent dir may already exist
      }
      this.dirReady = true;
    }
    appendFileSync(this.path, JSON.stringify(span) + "\n");
  }
}

// ---------------------------------------------------------------------------
// SpanHandle — mutable view for building a single span; the final Span emitted
// is immutable. Mutations are scoped to the handle, not the stored Span.
// ---------------------------------------------------------------------------

export interface SpanHandle {
  setAttribute(key: string, value: string | number | boolean): SpanHandle;
  setStatus(status: "ok" | "error" | "unset"): SpanHandle;
  /** Finalise the span and push it to the exporter. */
  end(): void;
  /** Read the current spanId (needed to set as parentId on children). */
  readonly spanId: string;
}

// ---------------------------------------------------------------------------
// Tracer
// ---------------------------------------------------------------------------

export interface TracerOptions {
  /** Override wall-clock source (ms since epoch). Defaults to Date.now. */
  readonly now?: () => number;
  /** Override span ID generation. Defaults to a monotonic counter. */
  readonly nextId?: () => string;
}

function makeDefaultIdGenerator(): () => string {
  let counter = 0;
  return (): string => {
    counter += 1;
    return String(counter);
  };
}

export class Tracer {
  private readonly exporter: SpanExporter;
  private readonly now: () => number;
  private readonly nextId: () => string;

  constructor(exporter: SpanExporter, options: TracerOptions = {}) {
    this.exporter = exporter;
    this.now = options.now ?? ((): number => Date.now());
    this.nextId = options.nextId ?? makeDefaultIdGenerator();
  }

  startSpan(
    name: string,
    attrs: Readonly<Record<string, string | number | boolean>> = {},
    parent?: SpanHandle,
  ): SpanHandle {
    const spanId = this.nextId();
    const startTime = this.now();
    // Build working state as a plain object; end() will freeze it.
    let currentAttrs: Record<string, string | number | boolean> = { ...attrs };
    let currentStatus: "ok" | "error" | "unset" = "unset";
    const exporter = this.exporter;
    const nowFn = this.now;
    const parentId = parent?.spanId;

    const handle: SpanHandle = {
      get spanId(): string {
        return spanId;
      },
      setAttribute(key: string, value: string | number | boolean): SpanHandle {
        currentAttrs = { ...currentAttrs, [key]: value };
        return handle;
      },
      setStatus(status: "ok" | "error" | "unset"): SpanHandle {
        currentStatus = status;
        return handle;
      },
      end(): void {
        const span: Span = {
          name,
          spanId,
          ...(parentId !== undefined ? { parentId } : {}),
          startTime,
          endTime: nowFn(),
          attributes: Object.freeze({ ...currentAttrs }),
          status: currentStatus,
        };
        void exporter.export(span);
      },
    };

    return handle;
  }
}

// ---------------------------------------------------------------------------
// Factory: build a tracer from the environment (opt-in via ALFRED_OTEL_FILE)
// ---------------------------------------------------------------------------

export function tracerFromEnv(options?: TracerOptions): Tracer {
  const filePath = process.env["ALFRED_OTEL_FILE"];
  const exporter: SpanExporter = filePath ? new FileExporter(filePath) : new NoopExporter();
  return new Tracer(exporter, options);
}
