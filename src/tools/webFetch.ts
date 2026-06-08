/**
 * web_fetch tool — controlled outbound HTTP fetch for Alfred.
 *
 * Implements the three-pillar lethal-trifecta mitigation (ADR 0003):
 *   1. Egress allow-list (default-deny): only hosts approved via
 *      `ALFRED_EGRESS_ALLOW` may be contacted.
 *   2. Taint: every successful fetch sets `untrusted: true` so the engine
 *      fences the content before it re-enters the prompt or ledger.
 *   3. Redaction: `redact()` scrubs secret-shaped substrings from the body
 *      before it is returned, preventing secrets on fetched pages from
 *      propagating into context or telemetry.
 */
import { z } from "zod";
import { buildTool } from "./types.ts";
import type { ToolResult } from "./types.ts";
import {
  checkEgress,
  DEFAULT_EGRESS_POLICY,
} from "../security/egress.ts";
import type { EgressPolicy } from "../security/egress.ts";
import { redact } from "../security/redact.ts";
import { ask, deny } from "../permissions/types.ts";

// ---------------------------------------------------------------------------
// Re-export EgressPolicy so callers can type-annotate without a separate
// import from security/egress.ts.
// ---------------------------------------------------------------------------
export type { EgressPolicy };

// ---------------------------------------------------------------------------
// policyFromEnv
// ---------------------------------------------------------------------------

/**
 * Build an {@link EgressPolicy} from the `ALFRED_EGRESS_ALLOW` environment
 * variable.
 *
 * - If the variable is absent or empty, returns `DEFAULT_EGRESS_POLICY`
 *   (deny-all).
 * - Otherwise, splits on commas, trims whitespace, and drops blank entries.
 *
 * @param env  Environment map to read from (defaults to `process.env`).
 */
export function policyFromEnv(
  env: Record<string, string | undefined> = process.env,
): EgressPolicy {
  const raw = env["ALFRED_EGRESS_ALLOW"];
  if (!raw || raw.trim() === "") {
    return DEFAULT_EGRESS_POLICY;
  }
  const allowHosts = raw
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  if (allowHosts.length === 0) {
    return DEFAULT_EGRESS_POLICY;
  }
  return { allowHosts };
}

// ---------------------------------------------------------------------------
// fetchWithPolicy
// ---------------------------------------------------------------------------

/** Minimal fetch call-signature — all `fetchWithPolicy` needs (keeps test fakes simple). */
export type Fetcher = (url: string) => Promise<Response>;

/** Options for {@link fetchWithPolicy}. */
export interface FetchWithPolicyOptions {
  readonly policy: EgressPolicy;
  /** Injectable fetcher — defaults to the global `fetch`. Useful in tests. */
  readonly fetcher?: Fetcher;
  /** Maximum body size in characters (default 100_000). */
  readonly maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 100_000;

/** Cap on redirect hops followed manually (each one is re-checked against egress). */
const MAX_REDIRECTS = 5;

/** HTTP status codes that represent a redirect we must follow manually. */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Default fetcher: disables automatic redirect-following (`redirect: "manual"`)
 * so `fetchWithPolicy` can re-apply the egress allow-list to every hop. Letting
 * the platform follow 30x responses would let an allowed host bounce the
 * request to a denied one, silently bypassing the allow-list (SSRF / ADR 0003).
 */
const defaultFetcher: Fetcher = (url) => fetch(url, { redirect: "manual" });

/**
 * Fetch `url` subject to an egress policy.
 *
 * Returns a discriminated union so callers never need to catch:
 * - `{ ok: true; body: string; status: number }` on success.
 * - `{ ok: false; error: string }` when egress is denied, the request fails,
 *   or the response status is non-2xx.
 *
 * Body is truncated to `maxBytes` characters when the response is large.
 * The body is **not** redacted here — redaction is the tool layer's
 * responsibility so that this pure-ish function stays easy to test.
 *
 * @param url   The URL to fetch.
 * @param opts  Policy, optional injected fetcher, and body size cap.
 */
export async function fetchWithPolicy(
  url: string,
  opts: FetchWithPolicyOptions,
): Promise<{ ok: true; body: string; status: number } | { ok: false; error: string }> {
  const { policy, fetcher = defaultFetcher, maxBytes = DEFAULT_MAX_BYTES } = opts;

  // Follow redirects manually, re-validating egress on EVERY hop. A single
  // initial check is not enough: a permitted host can 30x to a denied one, and
  // auto-follow would carry the request there, bypassing the allow-list.
  let currentUrl = url;
  let response: Response;
  for (let hop = 0; ; hop++) {
    const egressResult = checkEgress(currentUrl, policy);
    if (!egressResult.allowed) {
      return { ok: false, error: egressResult.reason };
    }

    try {
      response = await fetcher(currentUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Network error fetching ${currentUrl}: ${message}` };
    }

    if (!isRedirectStatus(response.status)) break;

    if (hop >= MAX_REDIRECTS) {
      return { ok: false, error: `Too many redirects (>${MAX_REDIRECTS}) starting at ${url}` };
    }
    const location = response.headers.get("location");
    if (location === null || location.trim() === "") {
      return { ok: false, error: `Redirect ${response.status} from ${currentUrl} had no Location header` };
    }
    try {
      currentUrl = new URL(location, currentUrl).toString(); // resolve relative redirects
    } catch {
      return { ok: false, error: `Invalid redirect target "${location}" from ${currentUrl}` };
    }
  }

  if (!response.ok) {
    return {
      ok: false,
      error: `HTTP ${response.status} ${response.statusText} for ${currentUrl}`,
    };
  }

  let body: string;
  try {
    body = await response.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to read response body: ${message}` };
  }

  if (body.length > maxBytes) {
    body = body.slice(0, maxBytes);
  }

  return { ok: true, body, status: response.status };
}

// ---------------------------------------------------------------------------
// webFetchTool
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  url: z.string().describe("The URL to fetch (http or https only)."),
  maxBytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Maximum body characters to return (default ${DEFAULT_MAX_BYTES}).`),
});

/** Alfred built-in tool: controlled outbound HTTP fetch (ADR 0003). */
export const webFetchTool = buildTool({
  name: "web_fetch",
  description:
    "Fetch a URL over HTTP/HTTPS. Only hosts on the ALFRED_EGRESS_ALLOW allow-list are " +
    "permitted (default-deny). The returned body is tainted as untrusted and secrets are " +
    "redacted before the content enters context.",
  inputSchema,

  // Network egress is not read-only — it has side effects on remote servers
  // and must not be auto-allowed or run concurrently without deliberate policy.
  isReadOnly: () => false,

  checkPermissions: async (input) => {
    const policy = policyFromEnv();
    const egressResult = checkEgress(input.url, policy);
    if (!egressResult.allowed) {
      return deny(egressResult.reason);
    }
    // Host is on the allow-list; still require explicit approval so the user
    // sees every outbound fetch even in acceptEdits mode. The engine bypasses
    // this gate in bypass/autonomous mode.
    return ask(`fetch ${input.url}`);
  },

  call: async (input): Promise<ToolResult<string>> => {
    const result = await fetchWithPolicy(input.url, {
      policy: policyFromEnv(),
      maxBytes: input.maxBytes,
    });

    if (!result.ok) {
      return { content: result.error, isError: true };
    }

    return { content: redact(result.body), untrusted: true };
  },

  describeCall: (input) => `web_fetch(${input.url})`,
});
