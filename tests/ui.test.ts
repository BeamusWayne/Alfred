import { describe, test, expect } from "bun:test";
import { Repl, type StreamChunk } from "../src/components/Repl.js";
import React from "react";

describe("Repl component", () => {
  test("Repl is a valid React component", () => {
    expect(Repl).toBeDefined();
    expect(typeof Repl).toBe("function");
  });

  test("Repl can be instantiated with createElement", () => {
    const element = React.createElement(Repl, {
      onSubmit: async (_input: string, _onChunk: (chunk: StreamChunk) => void) => {},
      modelName: "test-model",
    });
    expect(element).toBeDefined();
    expect(element.type).toBe(Repl);
  });

  test("CLI --help still works", async () => {
    const proc = Bun.spawn(["bun", "run", "src/index.ts", "--help"], {
      cwd: import.meta.dir.replace("/tests", ""),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}` },
    });
    const exitCode = await proc.exited;
    const output = await new Response(proc.stdout).text();
    expect(exitCode).toBe(0);
    expect(output).toContain("AI-powered CLI coding assistant");
  });
});
