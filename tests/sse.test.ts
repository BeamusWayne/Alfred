import { describe, test, expect } from "bun:test";
import { sseData } from "../src/providers/sse.ts";

function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

async function collect(s: ReadableStream<Uint8Array> | null): Promise<string[]> {
  const out: string[] = [];
  for await (const d of sseData(s)) out.push(d);
  return out;
}

describe("sseData", () => {
  test("yields each data payload, stops at [DONE]", async () => {
    const out = await collect(streamOf(['data: {"a":1}\n\n', 'data: {"b":2}\n\n', "data: [DONE]\n\n"]));
    expect(out).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("reassembles an event split across network chunks", async () => {
    const out = await collect(streamOf(['data: {"a":', "1}\n", "\ndata: {", '"b":2}\n\n']));
    expect(out).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("handles CRLF event separators (Gemini's alt=sse uses \\r\\n\\r\\n)", async () => {
    const out = await collect(streamOf(['data: {"a":1}\r\n\r\n', 'data: {"b":2}\r\n\r\n']));
    expect(out).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("handles CRLF split across chunks", async () => {
    const out = await collect(streamOf(['data: {"a":1}\r\n', '\r\ndata: {"b":2}\r\n\r\n']));
    expect(out).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("ignores comment/event lines and joins multi-line data", async () => {
    const out = await collect(streamOf([": keep-alive\n\n", "event: x\ndata: line1\ndata: line2\n\n"]));
    expect(out).toEqual(["line1\nline2"]);
  });

  test("flushes a trailing event with no terminating blank line", async () => {
    const out = await collect(streamOf(['data: {"a":1}']));
    expect(out).toEqual(['{"a":1}']);
  });

  test("null body yields nothing", async () => {
    expect(await collect(null)).toEqual([]);
  });
});
