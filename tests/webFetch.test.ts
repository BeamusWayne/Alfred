/**
 * Tests for the web_fetch tool (ADR 0003 — egress allow-list + taint + redaction).
 *
 * All tests use an injected fake `fetcher` — no real network calls are made.
 */
import { describe, test, expect } from "bun:test";
import {
  policyFromEnv,
  fetchWithPolicy,
  webFetchTool,
} from "../src/tools/webFetch.ts";
import type { Fetcher } from "../src/tools/webFetch.ts";
import { DEFAULT_EGRESS_POLICY } from "../src/security/egress.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal fake Response. */
function fakeResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    statusText: status === 200 ? "OK" : "Error",
  });
}

/** Fake fetcher that always succeeds with a given body. */
function okFetcher(body: string, status = 200): Fetcher {
  return (_url) => Promise.resolve(fakeResponse(body, status));
}

/** Fake fetcher that rejects with a network error. */
function networkErrorFetcher(): Fetcher {
  return (_url) => Promise.reject(new Error("ECONNREFUSED"));
}

// ---------------------------------------------------------------------------
// policyFromEnv
// ---------------------------------------------------------------------------

describe("policyFromEnv", () => {
  test("returns deny-all when ALFRED_EGRESS_ALLOW is unset", () => {
    const policy = policyFromEnv({});
    expect(policy).toEqual(DEFAULT_EGRESS_POLICY);
    expect(policy.allowHosts).toHaveLength(0);
  });

  test("returns deny-all when ALFRED_EGRESS_ALLOW is empty string", () => {
    const policy = policyFromEnv({ ALFRED_EGRESS_ALLOW: "" });
    expect(policy).toEqual(DEFAULT_EGRESS_POLICY);
  });

  test("returns deny-all when ALFRED_EGRESS_ALLOW is only whitespace", () => {
    const policy = policyFromEnv({ ALFRED_EGRESS_ALLOW: "   " });
    expect(policy).toEqual(DEFAULT_EGRESS_POLICY);
  });

  test("parses a single host", () => {
    const policy = policyFromEnv({ ALFRED_EGRESS_ALLOW: "docs.python.org" });
    expect(policy.allowHosts).toEqual(["docs.python.org"]);
  });

  test("parses a comma-separated list of hosts", () => {
    const policy = policyFromEnv({
      ALFRED_EGRESS_ALLOW: "docs.python.org,api.github.com",
    });
    expect(policy.allowHosts).toEqual(["docs.python.org", "api.github.com"]);
  });

  test("parses a wildcard pattern in the list", () => {
    const policy = policyFromEnv({
      ALFRED_EGRESS_ALLOW: "docs.python.org,*.github.com,api.example.com",
    });
    expect(policy.allowHosts).toEqual([
      "docs.python.org",
      "*.github.com",
      "api.example.com",
    ]);
  });

  test("trims whitespace around entries", () => {
    const policy = policyFromEnv({
      ALFRED_EGRESS_ALLOW: " docs.python.org , *.github.com ",
    });
    expect(policy.allowHosts).toEqual(["docs.python.org", "*.github.com"]);
  });

  test("skips blank entries produced by trailing comma", () => {
    const policy = policyFromEnv({
      ALFRED_EGRESS_ALLOW: "docs.python.org,",
    });
    expect(policy.allowHosts).toEqual(["docs.python.org"]);
  });
});

// ---------------------------------------------------------------------------
// fetchWithPolicy — egress enforcement
// ---------------------------------------------------------------------------

describe("fetchWithPolicy — egress enforcement", () => {
  test("deny-all policy rejects any URL with a clear reason", async () => {
    const result = await fetchWithPolicy("https://example.com/page", {
      policy: DEFAULT_EGRESS_POLICY,
      fetcher: okFetcher("should not reach"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/deny-all/i);
    }
  });

  test("host not in allow-list returns ok:false", async () => {
    const policy = policyFromEnv({ ALFRED_EGRESS_ALLOW: "docs.python.org" });
    const result = await fetchWithPolicy("https://evil.com/exfil", {
      policy,
      fetcher: okFetcher("should not reach"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not in the egress allow-list/i);
    }
  });

  test("allow-listed host fetches successfully and returns body", async () => {
    const policy = policyFromEnv({ ALFRED_EGRESS_ALLOW: "docs.python.org" });
    const result = await fetchWithPolicy("https://docs.python.org/3/", {
      policy,
      fetcher: okFetcher("Python docs content"),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body).toBe("Python docs content");
      expect(result.status).toBe(200);
    }
  });

  test("wildcard host pattern allows matching subdomain", async () => {
    const policy = policyFromEnv({ ALFRED_EGRESS_ALLOW: "*.github.com" });
    const result = await fetchWithPolicy("https://api.github.com/repos", {
      policy,
      fetcher: okFetcher("github api data"),
    });
    expect(result.ok).toBe(true);
  });

  test("wildcard does not allow the bare domain", async () => {
    const policy = policyFromEnv({ ALFRED_EGRESS_ALLOW: "*.github.com" });
    const result = await fetchWithPolicy("https://github.com/", {
      policy,
      fetcher: okFetcher("should not reach"),
    });
    expect(result.ok).toBe(false);
  });

  test("rejects non-http(s) scheme", async () => {
    const policy = policyFromEnv({ ALFRED_EGRESS_ALLOW: "localhost" });
    const result = await fetchWithPolicy("file:///etc/passwd", {
      policy,
      fetcher: okFetcher("should not reach"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not permitted/i);
    }
  });
});

// ---------------------------------------------------------------------------
// fetchWithPolicy — non-2xx responses
// ---------------------------------------------------------------------------

describe("fetchWithPolicy — non-2xx responses", () => {
  test("404 returns ok:false with status in error message", async () => {
    const policy = policyFromEnv({ ALFRED_EGRESS_ALLOW: "docs.python.org" });
    const result = await fetchWithPolicy("https://docs.python.org/missing", {
      policy,
      fetcher: okFetcher("not found body", 404),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/404/);
    }
  });

  test("500 returns ok:false", async () => {
    const policy = policyFromEnv({ ALFRED_EGRESS_ALLOW: "api.example.com" });
    const result = await fetchWithPolicy("https://api.example.com/data", {
      policy,
      fetcher: okFetcher("server error", 500),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/500/);
    }
  });

  test("network error returns ok:false with error message", async () => {
    const policy = policyFromEnv({ ALFRED_EGRESS_ALLOW: "docs.python.org" });
    const result = await fetchWithPolicy("https://docs.python.org/3/", {
      policy,
      fetcher: networkErrorFetcher(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/ECONNREFUSED/);
    }
  });
});

// ---------------------------------------------------------------------------
// fetchWithPolicy — body size cap
// ---------------------------------------------------------------------------

describe("fetchWithPolicy — maxBytes cap", () => {
  test("body is truncated to maxBytes when response is larger", async () => {
    const policy = policyFromEnv({ ALFRED_EGRESS_ALLOW: "docs.python.org" });
    const largeBody = "x".repeat(200_000);
    const result = await fetchWithPolicy("https://docs.python.org/3/", {
      policy,
      fetcher: okFetcher(largeBody),
      maxBytes: 500,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.length).toBe(500);
    }
  });

  test("body shorter than maxBytes is returned in full", async () => {
    const policy = policyFromEnv({ ALFRED_EGRESS_ALLOW: "docs.python.org" });
    const result = await fetchWithPolicy("https://docs.python.org/3/", {
      policy,
      fetcher: okFetcher("short body"),
      maxBytes: 500,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body).toBe("short body");
    }
  });
});

// ---------------------------------------------------------------------------
// webFetchTool — redaction + taint
// ---------------------------------------------------------------------------

describe("webFetchTool — redaction and taint", () => {
  /**
   * Call the tool's `call` method with an injected fetcher by temporarily
   * setting the ALFRED_EGRESS_ALLOW env var and monkey-patching the global
   * fetch. Because `call` relies on `policyFromEnv()` and the global fetcher,
   * we override both for the duration of the call.
   *
   * A cleaner approach: the tool's `call` implementation uses `policyFromEnv()`
   * which reads `process.env`. We set process.env for the test then restore it.
   */
  async function callTool(
    url: string,
    body: string,
    allowHosts: string,
    maxBytes?: number,
  ) {
    const prevAllow = process.env["ALFRED_EGRESS_ALLOW"];
    const prevFetch = globalThis.fetch;

    process.env["ALFRED_EGRESS_ALLOW"] = allowHosts;
    // Fake global fetch for the duration of the call.
    (globalThis as Record<string, unknown>)["fetch"] = okFetcher(body);

    try {
      const ctx = {
        workingDir: "/",
        signal: new AbortController().signal,
        readFileState: new Map(),
        permissions: {
          mode: "bypass" as const,
          allowedTools: new Set<string>(),
          deniedTools: new Set<string>(),
          workingDir: "/",
        },
      };
      return await webFetchTool.call({ url, maxBytes }, ctx);
    } finally {
      if (prevAllow === undefined) {
        delete process.env["ALFRED_EGRESS_ALLOW"];
      } else {
        process.env["ALFRED_EGRESS_ALLOW"] = prevAllow;
      }
      (globalThis as Record<string, unknown>)["fetch"] = prevFetch;
    }
  }

  test("result has untrusted:true on success", async () => {
    const result = await callTool(
      "https://docs.python.org/3/",
      "normal content",
      "docs.python.org",
    );
    expect(result.isError).toBeFalsy();
    expect(result.untrusted).toBe(true);
  });

  test("OpenAI key in body is redacted", async () => {
    const body = "Here is a secret: sk-abcdefghijklmnopqrstuvwxyz012345 end";
    const result = await callTool(
      "https://docs.python.org/3/",
      body,
      "docs.python.org",
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
    expect(result.content as string).toMatch(/\[REDACTED:/);
    expect(result.untrusted).toBe(true);
  });

  test("AWS access key in body is redacted", async () => {
    const key = "AKIA" + "A".repeat(16); // built at runtime — no scannable literal
    const result = await callTool(
      "https://docs.python.org/3/",
      `Credentials: ${key} end`,
      "docs.python.org",
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).not.toContain(key);
    expect(result.content as string).toMatch(/\[REDACTED:/);
  });

  test("isError:true and no untrusted flag when egress is denied", async () => {
    const result = await callTool(
      "https://evil.com/exfil",
      "should not appear",
      "docs.python.org",
    );
    expect(result.isError).toBe(true);
    expect(result.untrusted).toBeFalsy();
  });

  test("isError:true on non-2xx response", async () => {
    const prevAllow = process.env["ALFRED_EGRESS_ALLOW"];
    const prevFetch = globalThis.fetch;

    process.env["ALFRED_EGRESS_ALLOW"] = "docs.python.org";
    (globalThis as Record<string, unknown>)["fetch"] = okFetcher("not found", 404);

    try {
      const ctx = {
        workingDir: "/",
        signal: new AbortController().signal,
        readFileState: new Map(),
        permissions: {
          mode: "bypass" as const,
          allowedTools: new Set<string>(),
          deniedTools: new Set<string>(),
          workingDir: "/",
        },
      };
      const result = await webFetchTool.call(
        { url: "https://docs.python.org/missing" },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(result.untrusted).toBeFalsy();
    } finally {
      if (prevAllow === undefined) {
        delete process.env["ALFRED_EGRESS_ALLOW"];
      } else {
        process.env["ALFRED_EGRESS_ALLOW"] = prevAllow;
      }
      (globalThis as Record<string, unknown>)["fetch"] = prevFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// webFetchTool — describeCall and name
// ---------------------------------------------------------------------------

describe("webFetchTool — metadata", () => {
  test("name is web_fetch", () => {
    expect(webFetchTool.name).toBe("web_fetch");
  });

  test("describeCall formats correctly", () => {
    expect(webFetchTool.describeCall({ url: "https://example.com" })).toBe(
      "web_fetch(https://example.com)",
    );
  });

  test("isReadOnly returns false", () => {
    expect(webFetchTool.isReadOnly({ url: "https://example.com" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchWithPolicy — redirect handling (egress re-checked on EVERY hop)
// ---------------------------------------------------------------------------

/** A redirect Response carrying a Location header. */
function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

/**
 * Fetcher serving scripted responses keyed by URL, recording every URL it is
 * actually called with — so a test can assert a denied hop was never contacted.
 */
function routingFetcher(routes: Record<string, Response>): { fetcher: Fetcher; calls: string[] } {
  const calls: string[] = [];
  const fetcher: Fetcher = (url) => {
    calls.push(url);
    return Promise.resolve(routes[url] ?? fakeResponse("not found", 404));
  };
  return { fetcher, calls };
}

describe("fetchWithPolicy — redirect handling", () => {
  test("a redirect to a denied host is blocked and never contacted (no SSRF)", async () => {
    const policy = policyFromEnv({ ALFRED_EGRESS_ALLOW: "good.com" });
    const { fetcher, calls } = routingFetcher({
      "https://good.com/": redirectResponse("https://evil.com/exfil"),
      "https://evil.com/exfil": fakeResponse("SECRET DATA", 200),
    });

    const result = await fetchWithPolicy("https://good.com/", { policy, fetcher });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not in the egress allow-list/i);
    // The denied host must never have been fetched.
    expect(calls).toEqual(["https://good.com/"]);
  });

  test("a redirect to an allow-listed host is followed to completion", async () => {
    const policy = policyFromEnv({ ALFRED_EGRESS_ALLOW: "good.com,cdn.good.com" });
    const { fetcher, calls } = routingFetcher({
      "https://good.com/": redirectResponse("https://cdn.good.com/asset"),
      "https://cdn.good.com/asset": fakeResponse("final body", 200),
    });

    const result = await fetchWithPolicy("https://good.com/", { policy, fetcher });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toBe("final body");
    expect(calls).toEqual(["https://good.com/", "https://cdn.good.com/asset"]);
  });

  test("relative redirects resolve against the current URL", async () => {
    const policy = policyFromEnv({ ALFRED_EGRESS_ALLOW: "good.com" });
    const { fetcher } = routingFetcher({
      "https://good.com/a": redirectResponse("/b"),
      "https://good.com/b": fakeResponse("landed", 200),
    });
    const result = await fetchWithPolicy("https://good.com/a", { policy, fetcher });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toBe("landed");
  });

  test("a redirect loop is capped with a clear error", async () => {
    const policy = policyFromEnv({ ALFRED_EGRESS_ALLOW: "good.com" });
    const fetcher: Fetcher = () => Promise.resolve(redirectResponse("https://good.com/loop"));
    const result = await fetchWithPolicy("https://good.com/start", { policy, fetcher });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/too many redirects/i);
  });

  test("a redirect without a Location header is an error", async () => {
    const policy = policyFromEnv({ ALFRED_EGRESS_ALLOW: "good.com" });
    const fetcher: Fetcher = () => Promise.resolve(new Response(null, { status: 302 }));
    const result = await fetchWithPolicy("https://good.com/", { policy, fetcher });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no Location header/i);
  });
});
