/**
 * Tests for the eval harness (ADR 0004 — replay + assert regressions).
 *
 * Each EvalCase drives the REAL engine through a deterministic MockProvider
 * script and asserts observable properties: terminal status, tool call
 * sequence, text output, and count ceilings.
 */
import { describe, test, expect } from "bun:test";
import { textResponse, toolUseResponse } from "../src/providers/mock.ts";
import { runEvalCase, runEvalSuite, formatReport } from "../src/eval/runner.ts";
import type { EvalCase } from "../src/eval/types.ts";

// ---------------------------------------------------------------------------
// Shared eval cases
// ---------------------------------------------------------------------------

/** A passing case: two-step search-then-text run asserting tool order + status. */
const casePassToolSequence: EvalCase = {
  name: "search-then-respond",
  prompt: "List all txt files then tell me the result.",
  scripts: [
    toolUseResponse("glob", { pattern: "**/*.txt" }),
    textResponse("I found some files."),
  ],
  expect: {
    status: "success",
    toolsUsed: ["glob"],
    toolCallCountAtMost: 1,
    finalTextIncludes: ["found"],
  },
};

/**
 * A deliberately failing case: expects a tool that is never invoked, the wrong
 * terminal status, an impossible count ceiling, and a missing text substring.
 */
const caseFailAllExpectations: EvalCase = {
  name: "wrong-expectations",
  prompt: "Just say hello.",
  scripts: [textResponse("hello world")],
  expect: {
    // Engine produces "success" — assert "max_turns" to force a status failure.
    status: "max_turns",
    // "grep" is never called — forces a toolsUsed failure.
    toolsUsed: ["grep"],
    // 0 tools are called; ceiling of -1 is impossible but we use 0 to be clear
    // that even "no tools" violates the expectation when combined with the above.
    // (We use an impossible string to guarantee the text failure.)
    finalTextIncludes: ["THIS_SUBSTRING_WILL_NEVER_APPEAR"],
  },
};

/** A passing case: no tools, just verifying finalTextIncludes on a simple reply. */
const casePassTextOnly: EvalCase = {
  name: "text-only-match",
  prompt: "Say the word pineapple.",
  scripts: [textResponse("Here you go: pineapple!")],
  expect: {
    status: "success",
    finalTextIncludes: ["pineapple"],
  },
};

/** A failing case: the text assertion fails because the model says something else. */
const caseFailTextMismatch: EvalCase = {
  name: "text-mismatch",
  prompt: "Say hello.",
  scripts: [textResponse("hello there")],
  expect: {
    status: "success",
    // This substring is absent from the response.
    finalTextIncludes: ["EXPECTED_MISSING_STRING"],
  },
};

/** A passing case: two tools called in order. */
const casePassTwoToolsInOrder: EvalCase = {
  name: "two-tools-in-order",
  prompt: "Read file then write it back.",
  scripts: [
    toolUseResponse("file_read", { path: "tsconfig.json" }),
    toolUseResponse("glob", { pattern: "*.json" }),
    textResponse("All done."),
  ],
  expect: {
    status: "success",
    toolsUsed: ["file_read", "glob"],
    toolCallCountAtMost: 2,
    finalTextIncludes: ["done"],
  },
};

// ---------------------------------------------------------------------------
// runEvalCase — individual assertions
// ---------------------------------------------------------------------------

describe("runEvalCase", () => {
  test("passing case: correct tool sequence + status yields passed=true, no failures", async () => {
    const result = await runEvalCase(casePassToolSequence);
    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);
    expect(result.status).toBe("success");
    expect(result.toolsUsed).toContain("glob");
  });

  test("failing case: wrong expectations produce clear, human-readable failure messages", async () => {
    const result = await runEvalCase(caseFailAllExpectations);
    expect(result.passed).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);

    // Each failure message must name the field that failed.
    const allFailureText = result.failures.join("\n");
    expect(allFailureText).toContain("status");
    expect(allFailureText).toContain("toolsUsed");
    expect(allFailureText).toContain("finalTextIncludes");
  });

  test("failing status expectation names expected and actual status values", async () => {
    const result = await runEvalCase(caseFailAllExpectations);
    const statusFailure = result.failures.find((f) => f.startsWith("status:"));
    expect(statusFailure).toBeDefined();
    expect(statusFailure).toContain("max_turns");
    expect(statusFailure).toContain("success");
  });

  test("missing tool failure names the absent tool name", async () => {
    const result = await runEvalCase(caseFailAllExpectations);
    const toolFailure = result.failures.find((f) => f.startsWith("toolsUsed:"));
    expect(toolFailure).toBeDefined();
    expect(toolFailure).toContain("grep");
  });

  test("finalTextIncludes mismatch failure names the missing substring", async () => {
    const result = await runEvalCase(caseFailTextMismatch);
    expect(result.passed).toBe(false);
    const textFailure = result.failures.find((f) =>
      f.startsWith("finalTextIncludes:"),
    );
    expect(textFailure).toBeDefined();
    expect(textFailure).toContain("EXPECTED_MISSING_STRING");
  });

  test("text-only pass: finalTextIncludes match yields no failures", async () => {
    const result = await runEvalCase(casePassTextOnly);
    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  test("two tools in order: toolsUsed reflects call order", async () => {
    const result = await runEvalCase(casePassTwoToolsInOrder);
    expect(result.passed).toBe(true);
    expect(result.toolsUsed[0]).toBe("file_read");
    expect(result.toolsUsed[1]).toBe("glob");
  });

  test("turns counter reflects actual engine turns", async () => {
    const result = await runEvalCase(casePassToolSequence);
    // One tool use + one text reply = 2 turns.
    expect(result.turns).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// runEvalSuite — aggregation
// ---------------------------------------------------------------------------

describe("runEvalSuite", () => {
  test("aggregates pass and fail counts correctly", async () => {
    const suite = [
      casePassToolSequence,
      caseFailAllExpectations,
      casePassTextOnly,
      caseFailTextMismatch,
    ] as const;

    const report = await runEvalSuite(suite);
    expect(report.total).toBe(4);
    // Two cases are designed to pass, two to fail.
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(2);
    expect(report.results).toHaveLength(4);
  });

  test("all-passing suite yields failed=0", async () => {
    const report = await runEvalSuite([casePassToolSequence, casePassTextOnly]);
    expect(report.failed).toBe(0);
    expect(report.passed).toBe(2);
  });

  test("empty suite yields zero counts", async () => {
    const report = await runEvalSuite([]);
    expect(report.total).toBe(0);
    expect(report.passed).toBe(0);
    expect(report.failed).toBe(0);
  });

  test("results preserve original case order", async () => {
    const report = await runEvalSuite([casePassToolSequence, caseFailAllExpectations]);
    expect(report.results[0]?.name).toBe("search-then-respond");
    expect(report.results[1]?.name).toBe("wrong-expectations");
  });
});

// ---------------------------------------------------------------------------
// formatReport
// ---------------------------------------------------------------------------

describe("formatReport", () => {
  test("contains the summary line with pass/fail counts", async () => {
    const report = await runEvalSuite([casePassToolSequence, caseFailAllExpectations]);
    const out = formatReport(report);
    expect(out).toContain("1/2 passed");
    expect(out).toContain("1 failed");
  });

  test("contains case names for both passing and failing cases", async () => {
    const report = await runEvalSuite([casePassToolSequence, caseFailAllExpectations]);
    const out = formatReport(report);
    expect(out).toContain("search-then-respond");
    expect(out).toContain("wrong-expectations");
  });

  test("marks passing case with a check mark symbol", async () => {
    const report = await runEvalSuite([casePassToolSequence]);
    const out = formatReport(report);
    expect(out).toContain("✓");
  });

  test("marks failing case with an X symbol", async () => {
    const report = await runEvalSuite([caseFailAllExpectations]);
    const out = formatReport(report);
    expect(out).toContain("✗");
  });

  test("failure details are indented below the failing case name", async () => {
    const report = await runEvalSuite([caseFailAllExpectations]);
    const out = formatReport(report);
    const lines = out.split("\n");
    const caseLineIdx = lines.findIndex((l) => l.includes("wrong-expectations"));
    expect(caseLineIdx).toBeGreaterThanOrEqual(0);
    // At least one indented failure line follows the case line.
    const failureLine = lines
      .slice(caseLineIdx + 1)
      .find((l) => l.trimStart().startsWith("-"));
    expect(failureLine).toBeDefined();
  });

  test("all-passing report has no failure detail lines", async () => {
    const report = await runEvalSuite([casePassToolSequence, casePassTextOnly]);
    const out = formatReport(report);
    const lines = out.split("\n");
    const hasFailureDetail = lines.some((l) => l.trimStart().startsWith("-"));
    expect(hasFailureDetail).toBe(false);
  });
});
