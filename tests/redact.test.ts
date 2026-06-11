/**
 * Tests for secret redaction (ADR 0003 blast-radius reduction).
 *
 * redact() runs before content reaches telemetry, the signed ledger, or
 * external APIs, so a missed pattern is a real leak. All fixtures below are
 * synthetic, shaped like real credentials but never actual secrets.
 */
import { describe, expect, test } from "bun:test";
import { redact } from "../src/security/redact.ts";

describe("redact — provider key shapes", () => {
  // Fixtures are built at runtime (prefix + repeat) so no contiguous, scannable
  // credential literal lives in the source — they match the redaction regexes
  // without tripping GitHub secret-scanning.
  test("Anthropic keys", () => {
    const k = "sk-ant-" + "a".repeat(24);
    expect(redact(`key ${k} end`)).toBe("key [REDACTED:anthropic-key] end");
  });

  test("OpenAI keys (project and classic)", () => {
    expect(redact("sk-proj-" + "a".repeat(24))).toBe("[REDACTED:openai-key]");
    expect(redact("sk-" + "a".repeat(26))).toBe("[REDACTED:openai-key]");
  });

  test("AWS access key IDs", () => {
    expect(redact("AKIA" + "A".repeat(16))).toBe("[REDACTED:aws-access-key]");
  });

  test("GitHub tokens", () => {
    expect(redact("ghp_" + "a".repeat(30))).toBe("[REDACTED:github-token]");
  });

  test("Google API keys", () => {
    expect(redact("AIza" + "a".repeat(35))).toBe("[REDACTED:google-api-key]");
  });

  test("Zhipu GLM keys (<32 hex>.<16 alnum>) are redacted", () => {
    // The shape the project's own GLM credential uses: <32 hex>.<16 alnum>. The
    // hex half is only 32 chars (below the hex-blob threshold), so this rule is
    // what stops it leaking into logs / ledger / telemetry.
    const glm = "a".repeat(32) + "." + "b".repeat(16);
    expect(redact(`ANTHROPIC_API_KEY is ${glm} ok`)).toBe(
      "ANTHROPIC_API_KEY is [REDACTED:zhipu-glm-key] ok",
    );
  });
});

describe("redact — contextual shapes", () => {
  test("Bearer tokens keep the scheme word", () => {
    expect(redact("Authorization: Bearer abc.def.ghi123_-XYZ")).toBe(
      "Authorization: Bearer [REDACTED:bearer-token]",
    );
  });

  test("dotenv assignments keep the key name, redact the value", () => {
    expect(redact("API_KEY=supersecretvalue123")).toBe("API_KEY=[REDACTED:dotenv]");
    expect(redact("export DB_PASSWORD=hunter2hunter2")).toBe(
      "export DB_PASSWORD=[REDACTED:dotenv]",
    );
  });

  test("dotenv redaction fires mid-line, not just at line start", () => {
    // A secret embedded in a log line / fetched page must still be scrubbed.
    expect(redact("[info] DB_PASSWORD=Tr0ub4dor connecting")).toBe(
      "[info] DB_PASSWORD=[REDACTED:dotenv] connecting",
    );
    expect(redact("url?API_KEY=abc123def456 trailing")).toBe(
      "url?API_KEY=[REDACTED:dotenv] trailing",
    );
  });

  test("long hex and base64 blobs", () => {
    expect(redact("a".repeat(40)).startsWith("[REDACTED:")).toBe(true);
    const b64 = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5"; // 48 chars
    expect(redact(b64)).toBe("[REDACTED:base64-blob]");
  });
});

describe("redact — conservative (no false positives)", () => {
  test("ordinary prose is untouched", () => {
    const prose = "The quick brown fox jumps over the lazy dog near the river.";
    expect(redact(prose)).toBe(prose);
  });

  test("a bare 32-hex value (e.g. an MD5) is NOT redacted", () => {
    // Only the full GLM shape (hex + '.' + 16 alnum) is a secret; a lone
    // 32-char hash is legitimate to log, so it must pass through.
    const md5 = "0123456789abcdef0123456789abcdef";
    expect(redact(md5)).toBe(md5);
  });

  test("does not mutate or wrap when there is nothing to redact", () => {
    expect(redact("")).toBe("");
    expect(redact("plain")).toBe("plain");
  });
});
