/**
 * Egress allow-list: default-deny outbound network policy that restricts which
 * hosts the agent may contact. Implements Sophos-style blast-radius reduction
 * as part of the lethal-trifecta mitigation (ADR 0003).
 *
 * Rules:
 *   - Only http: and https: schemes are permitted.
 *   - Patterns without a wildcard are exact-hostname matches.
 *   - Patterns prefixed with `*.` match any direct subdomain (one level).
 *   - `DEFAULT_EGRESS_POLICY` is deny-all (empty allow-list).
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const egressPolicySchema = z.object({
  allowHosts: z
    .array(z.string().min(1))
    .readonly()
    .describe(
      'Allowed hostnames or wildcard patterns (e.g. "api.example.com", "*.example.com").',
    ),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EgressPolicy {
  readonly allowHosts: readonly string[];
}

export type EgressResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Deny-all policy — no outbound connections are permitted. */
export const DEFAULT_EGRESS_POLICY: EgressPolicy = { allowHosts: [] };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/**
 * Parse `rawUrl` and return the `URL` object, or `null` when malformed.
 * Using the WHATWG `URL` constructor is the safest way to parse URLs without
 * relying on fragile regex.
 */
function parseUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

/**
 * Test whether `host` is matched by `pattern`.
 *
 * - Exact: `"api.example.com"` matches only `"api.example.com"`.
 * - Wildcard: `"*.example.com"` matches `"foo.example.com"` but not
 *   `"example.com"` or `"a.b.example.com"` (one subdomain level only).
 */
function matchesPattern(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // ".example.com"
    if (!host.endsWith(suffix)) return false;
    // Ensure exactly one subdomain level: "foo.example.com" ✓ but not "example.com"
    const prefix = host.slice(0, host.length - suffix.length);
    return prefix.length > 0 && !prefix.includes(".");
  }
  return host === pattern;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether `url` is permitted by `policy`.
 *
 * Rejects:
 *   - Malformed URLs.
 *   - Non-http(s) schemes (file:, ftp:, data:, javascript:, …).
 *   - Hosts not present in the allow-list (default-deny).
 *
 * @param url    The raw URL string to validate.
 * @param policy The egress policy to apply.
 * @returns      `{ allowed: true }` or `{ allowed: false, reason }`.
 */
export function checkEgress(url: string, policy: EgressPolicy): EgressResult {
  const parsed = parseUrl(url);
  if (parsed === null) {
    return { allowed: false, reason: `Malformed URL: ${url}` };
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return {
      allowed: false,
      reason: `Scheme "${parsed.protocol.replace(/:$/, "")}" is not permitted; only http and https are allowed.`,
    };
  }

  const host = parsed.hostname.toLowerCase();

  const matched = policy.allowHosts.some((pattern) =>
    matchesPattern(host, pattern.toLowerCase()),
  );

  if (!matched) {
    return {
      allowed: false,
      reason:
        policy.allowHosts.length === 0
          ? `Egress is deny-all; no hosts are permitted.`
          : `Host "${host}" is not in the egress allow-list.`,
    };
  }

  return { allowed: true };
}
