/**
 * Google Gemini provider — implements the neutral `Provider` interface against
 * the native Gemini REST API (generativelanguage.googleapis.com, v1beta
 * `:generateContent`). NOT the OpenAI-compat shim — this speaks Gemini's own
 * `contents`/`parts`/`functionCall` wire format for faithful tool calling.
 *
 * ADR 0005 (multi-provider routing + fallback). Uses the global `fetch` (Bun);
 * no `@google/genai` package required.
 *
 * Key correlation note: Gemini correlates tool calls by function NAME (not by
 * an id like OpenAI/Anthropic). Alfred carries ids, so when replaying a
 * `tool_result` we look up the originating call's name from the preceding
 * assistant turn's `tool_use` blocks.
 */

import {
  ProviderError,
  type ChatOptions,
  type ContentBlock,
  type LLMResponse,
  type Message,
  type Provider,
  type ProviderConfig,
  type StopReason,
  type ToolDefinition,
  type Usage,
} from "./types.ts";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

// Gemini's transient statuses (429 RESOURCE_EXHAUSTED, 5xx) — mirrors the other
// providers so the retry layer treats the same conditions consistently.
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

// ---------------------------------------------------------------------------
// Inbound wire types (unknown at the HTTP boundary, narrowed below)
// ---------------------------------------------------------------------------

interface GeminiPart {
  readonly text?: string;
  readonly functionCall?: { readonly name?: string; readonly args?: Record<string, unknown> };
}

interface GeminiCandidate {
  readonly content?: { readonly role?: string; readonly parts?: readonly GeminiPart[] };
  readonly finishReason?: string;
}

interface GeminiUsage {
  readonly promptTokenCount?: number;
  readonly candidatesTokenCount?: number;
  readonly cachedContentTokenCount?: number;
}

interface GeminiResponse {
  readonly candidates?: readonly GeminiCandidate[];
  readonly usageMetadata?: GeminiUsage;
  readonly modelVersion?: string;
  readonly promptFeedback?: { readonly blockReason?: string };
}

// ---------------------------------------------------------------------------
// Outbound wire types (request body)
// ---------------------------------------------------------------------------

interface GeminiRequestPart {
  readonly text?: string;
  readonly functionCall?: { readonly name: string; readonly args: Record<string, unknown> };
  readonly functionResponse?: { readonly name: string; readonly response: Record<string, unknown> };
}

interface GeminiContentMsg {
  readonly role: "user" | "model";
  readonly parts: readonly GeminiRequestPart[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Coerce to a finite number; anything else (undefined, NaN) becomes 0. */
function finiteNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Reduce a JSON Schema to the small OpenAPI-3.0 subset Gemini's function
 * declaration parser accepts. This is an ALLOWLIST, not a denylist: Gemini
 * rejects unknown keys outright ("Unknown name 'exclusiveMinimum'"), and
 * Zod emits many such constraints (`exclusiveMinimum`, `minLength`, `pattern`,
 * `format`, `$schema`, `additionalProperties`, …), so only the structural
 * keywords are kept. `properties` is handled specially — its KEYS are arbitrary
 * property names (kept), its VALUES are sub-schemas (recursed).
 */
function sanitizeSchema(schema: unknown): Record<string, unknown> {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return {};
  }
  const s = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  if (typeof s["type"] === "string") out["type"] = s["type"];
  if (typeof s["description"] === "string") out["description"] = s["description"];
  if (typeof s["nullable"] === "boolean") out["nullable"] = s["nullable"];
  if (Array.isArray(s["enum"])) out["enum"] = s["enum"];
  if (Array.isArray(s["required"])) out["required"] = s["required"];

  if (s["items"] !== undefined) out["items"] = sanitizeSchema(s["items"]);

  const props = s["properties"];
  if (props !== null && typeof props === "object" && !Array.isArray(props)) {
    const cleaned: Record<string, unknown> = {};
    for (const [name, sub] of Object.entries(props as Record<string, unknown>)) {
      cleaned[name] = sanitizeSchema(sub);
    }
    out["properties"] = cleaned;
  }

  return out;
}

function toGeminiFunctionDecl(t: ToolDefinition): Record<string, unknown> {
  const params = sanitizeSchema(t.inputSchema);
  const props = params["properties"];
  const hasProps = props !== null && typeof props === "object" && Object.keys(props as object).length > 0;
  return {
    name: t.name,
    description: t.description,
    // Omit `parameters` for no-arg tools; Gemini rejects an empty object schema.
    ...(hasProps ? { parameters: params } : {}),
  };
}

/** Map Alfred messages → Gemini `contents`, correlating tool ids back to names. */
function toGeminiContents(messages: readonly Message[]): readonly GeminiContentMsg[] {
  const out: GeminiContentMsg[] = [];
  const idToName = new Map<string, string>();
  let pending: GeminiRequestPart[] = [];

  const flush = (): void => {
    if (pending.length > 0) {
      out.push({ role: "user", parts: pending });
      pending = [];
    }
  };

  for (const m of messages) {
    if (m.role === "tool_result") {
      const name = idToName.get(m.toolUseId) ?? m.toolUseId;
      pending.push({
        functionResponse: {
          name,
          response: m.isError ? { error: m.content } : { result: m.content },
        },
      });
      continue;
    }

    flush();

    if (m.role === "user") {
      const text =
        typeof m.content === "string"
          ? m.content
          : m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
      out.push({ role: "user", parts: [{ text }] });
      continue;
    }

    // assistant
    const parts: GeminiRequestPart[] = [];
    for (const b of m.content) {
      if (b.type === "text") {
        if (b.text.length > 0) parts.push({ text: b.text });
      } else {
        idToName.set(b.id, b.name);
        parts.push({ functionCall: { name: b.name, args: b.input } });
      }
    }
    if (parts.length === 0) parts.push({ text: "" });
    out.push({ role: "model", parts });
  }

  flush();
  return out;
}

function fromGeminiFinish(reason: string | undefined): StopReason {
  switch (reason) {
    case "STOP":
      return "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "refusal";
    default:
      return "unknown";
  }
}

function fromGeminiResponse(raw: GeminiResponse, requestedModel: string): LLMResponse {
  const candidates = raw.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    const reason = raw.promptFeedback?.blockReason ?? "no candidates returned";
    throw new ProviderError(`Gemini returned no content (${reason})`, { retryable: false });
  }
  const cand = candidates[0]!;
  const parts = cand.content?.parts ?? [];

  const blocks: ContentBlock[] = [];
  let hasToolCall = false;
  let callIdx = 0;
  for (const p of parts) {
    if (typeof p.text === "string" && p.text.length > 0) {
      blocks.push({ type: "text", text: p.text });
    } else if (p.functionCall && typeof p.functionCall.name === "string") {
      hasToolCall = true;
      blocks.push({
        type: "tool_use",
        // Gemini omits ids; synthesise a unique one for this turn so Alfred can
        // correlate the eventual tool_result back to this call's name.
        id: `call_${p.functionCall.name}_${callIdx++}`,
        name: p.functionCall.name,
        input: p.functionCall.args ?? {},
      });
    }
  }

  // Gemini reports finishReason STOP even when it emitted a functionCall, so
  // tool_use is inferred from the parts, not the finishReason.
  const stopReason: StopReason = hasToolCall ? "tool_use" : fromGeminiFinish(cand.finishReason);

  const u = raw.usageMetadata ?? {};
  const usage: Usage = {
    inputTokens: finiteNum(u.promptTokenCount),
    outputTokens: finiteNum(u.candidatesTokenCount),
    cacheReadTokens: finiteNum(u.cachedContentTokenCount),
    cacheWriteTokens: 0,
  };

  return { content: blocks, stopReason, usage, model: raw.modelVersion ?? requestedModel };
}

async function toProviderError(response: Response): Promise<ProviderError> {
  const status = response.status;
  const retryable = RETRYABLE_STATUS.has(status);
  let message = `Gemini API error: HTTP ${status}`;
  try {
    const body: unknown = await response.json();
    const err = (body as { error?: { message?: string } })?.error;
    if (err?.message) message = err.message;
  } catch {
    // body not JSON — keep the generic message
  }
  return new ProviderError(message, { status, retryable });
}

// ---------------------------------------------------------------------------
// Fetcher (injectable for tests)
// ---------------------------------------------------------------------------

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class GoogleProvider implements Provider {
  readonly name = "google";

  readonly #fetcher: Fetcher;
  readonly #baseUrl: string;

  constructor(fetcher: Fetcher = fetch, baseUrl?: string) {
    this.#fetcher = fetcher;
    this.#baseUrl = baseUrl ?? process.env.ALFRED_BASE_URL ?? GEMINI_BASE;
  }

  async chat(
    messages: readonly Message[],
    tools: readonly ToolDefinition[],
    config: ProviderConfig,
    options?: ChatOptions,
  ): Promise<LLMResponse> {
    const apiKey =
      config.apiKey ?? process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new ProviderError("GOOGLE_API_KEY is not configured", { retryable: false });
    }

    const base = config.baseUrl ?? this.#baseUrl;
    const body = {
      ...(config.systemPrompt
        ? { systemInstruction: { parts: [{ text: config.systemPrompt }] } }
        : {}),
      contents: toGeminiContents(messages),
      ...(tools.length > 0
        ? { tools: [{ functionDeclarations: tools.map(toGeminiFunctionDecl) }] }
        : {}),
      generationConfig: {
        ...(config.maxTokens !== undefined ? { maxOutputTokens: config.maxTokens } : {}),
        ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
      },
    };

    const url = `${base}/models/${encodeURIComponent(config.model)}:generateContent`;

    let response: Response;
    try {
      response = await this.#fetcher(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: options?.signal,
      });
    } catch (err) {
      // A network-level failure throws; map to a RETRYABLE ProviderError so the
      // loop backs off, but preserve user-abort semantics.
      if (options?.signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new ProviderError(`Gemini request failed: ${msg}`, { retryable: true });
    }

    if (!response.ok) {
      throw await toProviderError(response);
    }

    const raw: unknown = await response.json();
    return fromGeminiResponse(raw as GeminiResponse, config.model);
  }
}
