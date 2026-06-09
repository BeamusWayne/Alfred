/**
 * Minimal Server-Sent-Events reader for streaming provider responses.
 *
 * Both the OpenAI and Gemini streaming endpoints return `text/event-stream`
 * with `data: <json>` lines separated by blank lines. This async generator
 * yields the raw payload string of each `data:` line (excluding the OpenAI
 * `[DONE]` sentinel), reassembling events split across network chunks.
 */
// Events are separated by a blank line. Per the SSE spec, line endings may be
// CRLF, LF, or CR — Gemini's `alt=sse` uses CRLF (`\r\n\r\n`), OpenAI uses LF
// (`\n\n`), so the separator must match all forms (an `\n\n`-only split silently
// fails on Gemini, batching every event into one unparsable blob).
const EVENT_SEP = /\r\n\r\n|\n\n|\r\r/;

export async function* sseData(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<string, void> {
  if (body === null) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Process every complete event in the buffer.
      let m: RegExpExecArray | null;
      while ((m = EVENT_SEP.exec(buffer)) !== null) {
        const rawEvent = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        const payload = extractData(rawEvent);
        if (payload === null) continue;
        if (payload === "[DONE]") return;
        yield payload;
      }
    }
    // Flush a trailing event with no terminating blank line.
    const tail = extractData(buffer);
    if (tail !== null && tail !== "[DONE]") yield tail;
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/**
 * Join the `data:` field(s) of one SSE event block into a single payload, per
 * the spec (multiple `data:` lines concatenate with `\n`). Non-data lines
 * (`event:`, `:` comments) are ignored.
 */
function extractData(eventBlock: string): string | null {
  const dataLines: string[] = [];
  for (const line of eventBlock.split(/\r\n|\n|\r/)) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0) return null;
  return dataLines.join("\n");
}
