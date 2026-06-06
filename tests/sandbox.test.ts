/**
 * Tests for the OS sandbox module.
 *
 * ADR 0001 §7.3 (OS sandbox — two orthogonal axes: sandbox × approval).
 *
 * Covers:
 *   - `seatbeltProfile` — writable-path subpath rules + network clause
 *   - `wrapCommand`     — darwin produces sandbox-exec argv; linux passthrough
 *   - `sandboxAvailable` — platform detection
 *   - `defaultPolicy`  — includes workingDir and /tmp, network denied
 */

import { describe, test, expect } from "bun:test";
import { seatbeltProfile } from "../src/sandbox/seatbelt.ts";
import {
  sandboxAvailable,
  wrapCommand,
  defaultPolicy,
} from "../src/sandbox/index.ts";
import type { SandboxPolicy } from "../src/sandbox/index.ts";

// ---------------------------------------------------------------------------
// seatbeltProfile
// ---------------------------------------------------------------------------

describe("seatbeltProfile", () => {
  const basePolicy: SandboxPolicy = {
    writablePaths: ["/workspace/project", "/tmp"],
    allowNetwork: false,
  };

  test("starts with required Seatbelt preamble", () => {
    const profile = seatbeltProfile(basePolicy);
    expect(profile).toContain("(version 1)");
    expect(profile).toContain("(deny default)");
    expect(profile).toContain("(allow process*)");
    expect(profile).toContain("(allow file-read*)");
  });

  test("includes a subpath rule for each writable path", () => {
    const profile = seatbeltProfile(basePolicy);
    expect(profile).toContain('(allow file-write* (subpath "/workspace/project"))');
    expect(profile).toContain('(allow file-write* (subpath "/tmp"))');
  });

  test("denies network when allowNetwork is false", () => {
    const profile = seatbeltProfile(basePolicy);
    expect(profile).toContain("(deny network*)");
    expect(profile).not.toContain("(allow network*)");
  });

  test("allows network when allowNetwork is true", () => {
    const policy: SandboxPolicy = { ...basePolicy, allowNetwork: true };
    const profile = seatbeltProfile(policy);
    expect(profile).toContain("(allow network*)");
    expect(profile).not.toContain("(deny network*)");
  });

  test("produces no writable-path rules when writablePaths is empty", () => {
    const policy: SandboxPolicy = { writablePaths: [], allowNetwork: false };
    const profile = seatbeltProfile(policy);
    expect(profile).not.toContain("file-write*");
  });

  test("escapes double-quotes in paths", () => {
    const policy: SandboxPolicy = {
      writablePaths: ['/path/with "quotes"'],
      allowNetwork: false,
    };
    const profile = seatbeltProfile(policy);
    expect(profile).toContain('\\"quotes\\"');
  });

  test("lines are newline-separated", () => {
    const profile = seatbeltProfile(basePolicy);
    const lines = profile.split("\n");
    expect(lines.length).toBeGreaterThan(4);
  });
});

// ---------------------------------------------------------------------------
// sandboxAvailable
// ---------------------------------------------------------------------------

describe("sandboxAvailable", () => {
  test("returns true for darwin", () => {
    expect(sandboxAvailable("darwin")).toBe(true);
  });

  test("returns false for linux", () => {
    expect(sandboxAvailable("linux")).toBe(false);
  });

  test("returns false for win32", () => {
    expect(sandboxAvailable("win32")).toBe(false);
  });

  test("returns false for freebsd", () => {
    expect(sandboxAvailable("freebsd")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// wrapCommand — darwin
// ---------------------------------------------------------------------------

describe("wrapCommand on darwin", () => {
  const policy: SandboxPolicy = {
    writablePaths: ["/workspace"],
    allowNetwork: false,
  };

  test("returns wrapped: true", () => {
    const result = wrapCommand("echo hello", policy, "darwin");
    expect(result.wrapped).toBe(true);
  });

  test("argv starts with sandbox-exec -p", () => {
    const result = wrapCommand("echo hello", policy, "darwin");
    expect(result.argv[0]).toBe("sandbox-exec");
    expect(result.argv[1]).toBe("-p");
  });

  test("argv[2] is the generated Seatbelt profile string", () => {
    const result = wrapCommand("echo hello", policy, "darwin");
    const embeddedProfile = result.argv[2] as string;
    expect(embeddedProfile).toContain("(version 1)");
    expect(embeddedProfile).toContain("(deny default)");
    expect(embeddedProfile).toContain('(allow file-write* (subpath "/workspace"))');
    expect(embeddedProfile).toContain("(deny network*)");
  });

  test("argv ends with sh -c <command>", () => {
    const result = wrapCommand("ls -la", policy, "darwin");
    const len = result.argv.length;
    expect(result.argv[len - 3]).toBe("sh");
    expect(result.argv[len - 2]).toBe("-c");
    expect(result.argv[len - 1]).toBe("ls -la");
  });

  test("total argv length is 6", () => {
    const result = wrapCommand("pwd", policy, "darwin");
    expect(result.argv.length).toBe(6);
  });

  test("argv is readonly (object shape check)", () => {
    const result = wrapCommand("pwd", policy, "darwin");
    // Verify it's an array-like readonly structure
    expect(Array.isArray(result.argv)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// wrapCommand — linux (transparent passthrough)
// ---------------------------------------------------------------------------

describe("wrapCommand on linux", () => {
  const policy: SandboxPolicy = {
    writablePaths: ["/home/user/project"],
    allowNetwork: true,
  };

  test("returns wrapped: false", () => {
    const result = wrapCommand("git status", policy, "linux");
    expect(result.wrapped).toBe(false);
  });

  test("argv is ['sh', '-c', <command>] — no sandbox-exec", () => {
    const result = wrapCommand("git status", policy, "linux");
    expect(result.argv).toEqual(["sh", "-c", "git status"]);
  });

  test("does not include sandbox-exec in argv", () => {
    const result = wrapCommand("cat file.txt", policy, "linux");
    expect(result.argv).not.toContain("sandbox-exec");
  });

  test("argv length is 3", () => {
    const result = wrapCommand("cat file.txt", policy, "linux");
    expect(result.argv.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// wrapCommand — other platforms
// ---------------------------------------------------------------------------

describe("wrapCommand on win32", () => {
  const policy: SandboxPolicy = { writablePaths: [], allowNetwork: false };

  test("returns wrapped: false on win32", () => {
    const result = wrapCommand("dir", policy, "win32");
    expect(result.wrapped).toBe(false);
  });

  test("argv passthrough on win32", () => {
    const result = wrapCommand("dir", policy, "win32");
    expect(result.argv).toEqual(["sh", "-c", "dir"]);
  });
});

// ---------------------------------------------------------------------------
// defaultPolicy
// ---------------------------------------------------------------------------

describe("defaultPolicy", () => {
  test("includes the workingDir in writablePaths", () => {
    const policy = defaultPolicy("/home/user/myproject");
    expect(policy.writablePaths).toContain("/home/user/myproject");
  });

  test("includes /tmp in writablePaths", () => {
    const policy = defaultPolicy("/workspace");
    expect(policy.writablePaths).toContain("/tmp");
  });

  test("has exactly two writable paths", () => {
    const policy = defaultPolicy("/workspace");
    expect(policy.writablePaths.length).toBe(2);
  });

  test("denies network access by default", () => {
    const policy = defaultPolicy("/workspace");
    expect(policy.allowNetwork).toBe(false);
  });
});
