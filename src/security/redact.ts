/**
 * Secret redaction: replaces known secret-shaped substrings with
 * `[REDACTED:<kind>]` before content reaches telemetry, ledger writes, or
 * external APIs. Implements Sophos-style blast-radius reduction (ADR 0003).
 *
 * Conservative by design — false positives (redacting normal prose) are worse
 * than false negatives for usability. Each rule targets a narrow, high-entropy
 * pattern or a well-known provider prefix.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SecretKind =
  | "dotenv"
  | "anthropic-key"
  | "openai-key"
  | "aws-access-key"
  | "github-token"
  | "google-api-key"
  | "bearer-token"
  | "hex-blob"
  | "base64-blob";

interface RedactionRule {
  readonly kind: SecretKind;
  readonly pattern: RegExp;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * Minimum lengths for opaque blob detection. Chosen to avoid redacting
 * short identifiers that happen to be hex/base64.
 *
 * For base64, the threshold applies to the non-padding character count so that
 * payloads like 43-char + 1 `=` (representing 32 bytes) are correctly caught
 * regardless of how many `=` padding chars follow. 40 non-pad base64 chars
 * encode 30 bytes — a comfortable lower bound for key material.
 */
const MIN_HEX_LENGTH = 40;
const MIN_BASE64_NONPAD_LENGTH = 40; // non-padding chars (= 30 raw bytes)

const RULES: readonly RedactionRule[] = [
  // dotenv assignment lines: KEY=VALUE where KEY hints at a secret
  // Matches the VALUE portion; replaces the whole match.
  {
    kind: "dotenv",
    pattern:
      /(?:^|(?<=\n))(?:export\s+)?(?:[A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD|PASSWD|API)[A-Z0-9_]*)=\S+/gm,
  },
  // Anthropic keys: sk-ant-api03-… or sk-ant-…
  {
    kind: "anthropic-key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{10,}\b/g,
  },
  // OpenAI keys: sk-proj-… or sk-… (not already caught by anthropic)
  {
    kind: "openai-key",
    pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g,
  },
  // AWS access key IDs: AKIA[A-Z0-9]{16}
  {
    kind: "aws-access-key",
    pattern: /\bAKIA[A-Z0-9]{16}\b/g,
  },
  // GitHub personal access tokens: ghp_ or gho_ prefix
  {
    kind: "github-token",
    pattern: /\bgh[po]_[A-Za-z0-9_]{20,}\b/g,
  },
  // Google API keys: AIza[0-9A-Za-z_-]{35}
  {
    kind: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  // Bearer tokens in Authorization headers (captures the token value)
  {
    kind: "bearer-token",
    pattern: /\bBearer\s+([A-Za-z0-9\-._~+/]+=*)/g,
  },
  // Long hex blobs (sha256 hashes, raw key material, etc.)
  {
    kind: "hex-blob",
    pattern: new RegExp(`\\b[0-9a-fA-F]{${MIN_HEX_LENGTH},}\\b`, "g"),
  },
  // Long base64 blobs (encoded keys, JWT payloads, etc.)
  // Threshold is on the non-padding portion so that a 43-char payload + 1 `=`
  // (32 bytes) is caught regardless of padding count.
  {
    kind: "base64-blob",
    pattern: new RegExp(
      `(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{${MIN_BASE64_NONPAD_LENGTH},}={0,2}(?![A-Za-z0-9+/=])`,
      "g",
    ),
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return a new string with secret-shaped substrings replaced by
 * `[REDACTED:<kind>]`. The original `text` is never mutated.
 *
 * Rules are applied in order; each rule operates on the result of the previous
 * one so that a single pass is sufficient per rule without back-tracking.
 *
 * @param text  Input text that may contain secrets.
 * @returns     Sanitised copy of `text`.
 */
export function redact(text: string): string {
  let result = text;

  for (const rule of RULES) {
    // Reset lastIndex before each use (global regexes are stateful).
    rule.pattern.lastIndex = 0;

    if (rule.kind === "bearer-token") {
      // Special case: preserve the word "Bearer" for readability; only
      // replace the token value captured in group 1.
      result = result.replace(rule.pattern, (_match, _token) => {
        return `Bearer [REDACTED:${rule.kind}]`;
      });
    } else if (rule.kind === "dotenv") {
      // Special case: preserve the KEY name so logs show which variable
      // was scrubbed (the value is sensitive, not the key name itself).
      result = result.replace(rule.pattern, (match) => {
        const eqIdx = match.indexOf("=");
        const keyPart = eqIdx >= 0 ? match.slice(0, eqIdx + 1) : match;
        return `${keyPart}[REDACTED:${rule.kind}]`;
      });
    } else {
      result = result.replace(rule.pattern, `[REDACTED:${rule.kind}]`);
    }
  }

  return result;
}
