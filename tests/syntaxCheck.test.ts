/**
 * Tests for the post-edit syntax check helper (ADR 0002 step 2).
 */
import { describe, expect, test } from "bun:test";
import { checkSyntax, isCheckable, LOADER_MAP } from "../src/tools/lib/syntaxCheck.ts";

// ---------------------------------------------------------------------------
// TypeScript
// ---------------------------------------------------------------------------
describe("checkSyntax — TypeScript (.ts)", () => {
  test("valid TS returns ok:true", () => {
    const code = `const x: number = 42;\nexport default x;\n`;
    expect(checkSyntax("src/foo.ts", code)).toEqual({ ok: true });
  });

  test("broken TS (unclosed paren) returns ok:false with a message", () => {
    const result = checkSyntax("src/foo.ts", "const x = (");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error).toBe("string");
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  test("valid TS with generics and interfaces passes", () => {
    const code = `
      interface User { readonly id: string; name: string }
      function greet<T extends User>(u: T): string { return u.name; }
    `;
    expect(checkSyntax("lib/utils.ts", code)).toEqual({ ok: true });
  });

  test(".mts and .cts extensions are checked as ts", () => {
    expect(checkSyntax("file.mts", "const x: number = 1;")).toEqual({ ok: true });
    expect(checkSyntax("file.cts", "const x: number = 1;")).toEqual({ ok: true });
    const broken = checkSyntax("file.mts", "const x = (");
    expect(broken.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TSX
// ---------------------------------------------------------------------------
describe("checkSyntax — TSX (.tsx)", () => {
  test("valid TSX with JSX syntax passes", () => {
    // Bun's transpiler handles JSX without a React import in scope
    const code = `function Cmp() { return <div className="x">hello</div>; }`;
    expect(checkSyntax("src/Cmp.tsx", code)).toEqual({ ok: true });
  });

  test("broken TSX returns ok:false", () => {
    const result = checkSyntax("src/Cmp.tsx", "function Cmp() { return <div");
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// JavaScript
// ---------------------------------------------------------------------------
describe("checkSyntax — JavaScript (.js / .mjs / .cjs)", () => {
  test("valid JS passes", () => {
    const code = `export function add(a, b) { return a + b; }`;
    expect(checkSyntax("util.js", code)).toEqual({ ok: true });
  });

  test("broken JS returns ok:false with a message", () => {
    const result = checkSyntax("util.js", "function f( {");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  test(".mjs and .cjs are checked", () => {
    expect(checkSyntax("mod.mjs", "export const x = 1;")).toEqual({ ok: true });
    expect(checkSyntax("mod.cjs", "module.exports = {};")).toEqual({ ok: true });
    expect(checkSyntax("mod.cjs", "function f( {").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------
describe("checkSyntax — JSX (.jsx)", () => {
  test("valid JSX passes", () => {
    const code = `function App() { return <main>hello</main>; }`;
    expect(checkSyntax("app.jsx", code)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------
describe("checkSyntax — JSON (.json)", () => {
  test("valid JSON passes", () => {
    expect(checkSyntax("package.json", '{"name":"alfred","version":"0.1.0"}')).toEqual({
      ok: true,
    });
  });

  test("broken JSON (trailing comma) returns ok:false with a message", () => {
    const result = checkSyntax("config.json", '{"key": "value",}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  test("broken JSON (unquoted key) returns ok:false", () => {
    expect(checkSyntax("data.json", "{key: 1}").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unknown / unhandled extensions → conservative pass-through
// ---------------------------------------------------------------------------
describe("checkSyntax — unknown extensions", () => {
  test(".py returns ok:true (not our problem)", () => {
    expect(checkSyntax("script.py", "def f(\n  # broken")).toEqual({ ok: true });
  });

  test(".txt returns ok:true", () => {
    expect(checkSyntax("notes.txt", "just some prose")).toEqual({ ok: true });
  });

  test(".rb returns ok:true", () => {
    expect(checkSyntax("app.rb", "def foo\n  bar(")).toEqual({ ok: true });
  });

  test("no extension returns ok:true", () => {
    expect(checkSyntax("Makefile", "broken {{{{")).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe("checkSyntax — edge cases", () => {
  test("empty string is ok for .ts", () => {
    expect(checkSyntax("src/empty.ts", "")).toEqual({ ok: true });
  });

  test("empty string is ok for .json", () => {
    expect(checkSyntax("data.json", "")).toEqual({ ok: true });
  });

  test("empty string is ok for unknown extension", () => {
    expect(checkSyntax("script.py", "")).toEqual({ ok: true });
  });

  test("error message is a single non-empty line (no newlines)", () => {
    const result = checkSyntax("src/foo.ts", "const x = (");
    if (!result.ok) {
      expect(result.error).not.toContain("\n");
    }
  });
});

// ---------------------------------------------------------------------------
// isCheckable
// ---------------------------------------------------------------------------
describe("isCheckable", () => {
  test("TS/TSX/JS/JSX/JSON extensions are checkable", () => {
    for (const ext of [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"]) {
      expect(isCheckable(`file${ext}`)).toBe(true);
    }
  });

  test(".py and .txt are not checkable", () => {
    expect(isCheckable("script.py")).toBe(false);
    expect(isCheckable("notes.txt")).toBe(false);
  });

  test("no extension is not checkable", () => {
    expect(isCheckable("Makefile")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LOADER_MAP export shape
// ---------------------------------------------------------------------------
describe("LOADER_MAP", () => {
  test("maps .ts → ts and .tsx → tsx", () => {
    expect(LOADER_MAP[".ts"]).toBe("ts");
    expect(LOADER_MAP[".tsx"]).toBe("tsx");
    expect(LOADER_MAP[".js"]).toBe("js");
    expect(LOADER_MAP[".jsx"]).toBe("jsx");
  });
});
