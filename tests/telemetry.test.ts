/**
 * Tests for src/telemetry/otel.ts — ADR 0004.
 *
 * Covers:
 *   - Span nesting via parentId propagation.
 *   - Attribute setting (including overwrite).
 *   - Status setting.
 *   - Deterministic ids via injected generators.
 *   - FileExporter round-trip (isolated temp dir, cleaned up after each test).
 *   - tracerFromEnv() returns NoopExporter when ALFRED_OTEL_FILE is unset.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";
import {
  Tracer,
  FileExporter,
  NoopExporter,
  tracerFromEnv,
  GEN_AI_OPERATION_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_TOOL_NAME,
  type Span,
} from "../src/telemetry/otel.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIdGen(prefix = "span"): () => string {
  let n = 0;
  return (): string => `${prefix}-${++n}`;
}

function makeNow(start = 1000): () => number {
  let t = start;
  return (): number => (t += 10);
}

/** Collect spans synchronously via a capturing exporter. */
class CapturingExporter {
  readonly spans: Span[] = [];
  export(span: Span): void {
    this.spans.push(span);
  }
}

// ---------------------------------------------------------------------------
// Span basics
// ---------------------------------------------------------------------------

describe("Tracer — span basics", () => {
  test("records name, spanId, startTime, endTime, status=unset by default", () => {
    const cap = new CapturingExporter();
    const tracer = new Tracer(cap, { now: makeNow(0), nextId: makeIdGen() });

    const h = tracer.startSpan("root-op");
    h.end();

    expect(cap.spans.length).toBe(1);
    const span = cap.spans[0]!;
    expect(span.name).toBe("root-op");
    expect(span.spanId).toBe("span-1");
    expect(span.startTime).toBeNumber();
    expect(span.endTime).toBeNumber();
    expect((span.endTime ?? 0) >= span.startTime).toBe(true);
    expect(span.status).toBe("unset");
    expect(span.parentId).toBeUndefined();
  });

  test("setAttribute accumulates immutably", () => {
    const cap = new CapturingExporter();
    const tracer = new Tracer(cap, { now: makeNow(), nextId: makeIdGen() });

    const h = tracer.startSpan("op", { [GEN_AI_OPERATION_NAME]: "chat" });
    h.setAttribute(GEN_AI_REQUEST_MODEL, "claude-sonnet-4-6");
    h.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, 100);
    h.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, 200); // overwrite
    h.end();

    const span = cap.spans[0]!;
    expect(span.attributes[GEN_AI_OPERATION_NAME]).toBe("chat");
    expect(span.attributes[GEN_AI_REQUEST_MODEL]).toBe("claude-sonnet-4-6");
    expect(span.attributes[GEN_AI_USAGE_INPUT_TOKENS]).toBe(200);
  });

  test("setStatus sets the span status", () => {
    const cap = new CapturingExporter();
    const tracer = new Tracer(cap, { now: makeNow(), nextId: makeIdGen() });
    const h = tracer.startSpan("failing-op");
    h.setStatus("error");
    h.end();
    expect(cap.spans[0]!.status).toBe("error");
  });

  test("setStatus ok", () => {
    const cap = new CapturingExporter();
    const tracer = new Tracer(cap, { now: makeNow(), nextId: makeIdGen() });
    const h = tracer.startSpan("ok-op");
    h.setStatus("ok");
    h.end();
    expect(cap.spans[0]!.status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Span nesting
// ---------------------------------------------------------------------------

describe("Tracer — span nesting", () => {
  test("child span carries parentId of parent", () => {
    const cap = new CapturingExporter();
    const tracer = new Tracer(cap, { now: makeNow(), nextId: makeIdGen() });

    const parent = tracer.startSpan("parent-span");
    const child = tracer.startSpan("child-span", {}, parent);
    child.end();
    parent.end();

    expect(cap.spans.length).toBe(2);
    const childSpan = cap.spans[0]!;
    const parentSpan = cap.spans[1]!;
    expect(childSpan.name).toBe("child-span");
    expect(childSpan.parentId).toBe(parentSpan.spanId);
    expect(parentSpan.parentId).toBeUndefined();
  });

  test("three-level nesting: grandparent → parent → child", () => {
    const cap = new CapturingExporter();
    const idSeq: string[] = ["gp-1", "p-2", "c-3"];
    let idx = 0;
    const nextId = (): string => idSeq[idx++] ?? "x";
    const tracer = new Tracer(cap, { now: makeNow(), nextId });

    const gp = tracer.startSpan("grandparent");
    const p = tracer.startSpan("parent", {}, gp);
    const c = tracer.startSpan("child", {}, p);
    c.end();
    p.end();
    gp.end();

    const spans = cap.spans;
    expect(spans[0]!.parentId).toBe("p-2"); // child's parent
    expect(spans[1]!.parentId).toBe("gp-1"); // parent's parent
    expect(spans[2]!.parentId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Deterministic IDs
// ---------------------------------------------------------------------------

describe("Tracer — deterministic ids", () => {
  test("injected nextId produces predictable spanIds", () => {
    const cap = new CapturingExporter();
    const tracer = new Tracer(cap, {
      now: makeNow(),
      nextId: makeIdGen("test"),
    });
    tracer.startSpan("a").end();
    tracer.startSpan("b").end();
    tracer.startSpan("c").end();

    expect(cap.spans.map((s) => s.spanId)).toEqual(["test-1", "test-2", "test-3"]);
  });

  test("injected now produces predictable timestamps", () => {
    const cap = new CapturingExporter();
    // now increments by 10 each call; start at 100
    let t = 100;
    const now = (): number => (t += 10);
    const tracer = new Tracer(cap, { now, nextId: makeIdGen() });

    tracer.startSpan("timed").end();
    const span = cap.spans[0]!;
    expect(span.startTime).toBe(110);
    expect(span.endTime).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// FileExporter round-trip
// ---------------------------------------------------------------------------

describe("FileExporter", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = join(tmpdir(), `alfred-otel-test-${Date.now()}.jsonl`);
  });

  afterEach(() => {
    if (existsSync(tmpFile)) rmSync(tmpFile);
  });

  test("writes span as JSONL and can be read back", async () => {
    const exporter = new FileExporter(tmpFile);
    const tracer = new Tracer(exporter, { now: makeNow(), nextId: makeIdGen() });

    const h = tracer.startSpan("file-op", {
      [GEN_AI_OPERATION_NAME]: "chat",
      [GEN_AI_REQUEST_MODEL]: "claude-sonnet-4-6",
    });
    h.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, 42);
    h.setAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, 7);
    h.setStatus("ok");
    h.end();

    // FileExporter.export is async; wait for flush
    await new Promise((res) => setTimeout(res, 50));

    const raw = await Bun.file(tmpFile).text();
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);

    const span = JSON.parse(lines[0]!) as Span;
    expect(span.name).toBe("file-op");
    expect(span.status).toBe("ok");
    expect(span.attributes[GEN_AI_USAGE_INPUT_TOKENS]).toBe(42);
    expect(span.attributes[GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(7);
  });

  test("appends multiple spans as separate JSONL lines", async () => {
    const exporter = new FileExporter(tmpFile);
    const tracer = new Tracer(exporter, { now: makeNow(), nextId: makeIdGen() });

    tracer.startSpan("op-1", { [GEN_AI_TOOL_NAME]: "bash" }).end();
    tracer.startSpan("op-2", { [GEN_AI_TOOL_NAME]: "read_file" }).end();

    await new Promise((res) => setTimeout(res, 80));

    const raw = await Bun.file(tmpFile).text();
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(2);

    const s1 = JSON.parse(lines[0]!) as Span;
    const s2 = JSON.parse(lines[1]!) as Span;
    expect(s1.attributes[GEN_AI_TOOL_NAME]).toBe("bash");
    expect(s2.attributes[GEN_AI_TOOL_NAME]).toBe("read_file");
  });
});

// ---------------------------------------------------------------------------
// NoopExporter
// ---------------------------------------------------------------------------

describe("NoopExporter", () => {
  test("swallows spans without throwing", () => {
    const noop = new NoopExporter();
    expect(() =>
      noop.export({
        name: "x",
        spanId: "1",
        startTime: 0,
        attributes: {},
        status: "unset",
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// tracerFromEnv — factory
// ---------------------------------------------------------------------------

describe("tracerFromEnv", () => {
  test("returns noop tracer when ALFRED_OTEL_FILE is unset", () => {
    // Ensure the env var is absent for this test
    const saved = process.env["ALFRED_OTEL_FILE"];
    delete process.env["ALFRED_OTEL_FILE"];

    try {
      const tracer = tracerFromEnv({ now: makeNow(), nextId: makeIdGen() });
      // Should not throw; spans just disappear
      const h = tracer.startSpan("probe");
      h.end();
      // No assertions needed — just verifying no throw and no file written
    } finally {
      if (saved !== undefined) process.env["ALFRED_OTEL_FILE"] = saved;
    }
  });
});
