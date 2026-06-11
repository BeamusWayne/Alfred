/**
 * Tests for interactive tool approval (src/cli/approve.ts): the y/n/a
 * decision logic, per-tool "always" memory, and deny-by-default on anything
 * unrecognised.
 */
import { describe, expect, test } from "bun:test";
import { createApprover } from "../src/cli/approve.ts";
import type { ApprovalRequest } from "../src/query/types.ts";

function req(toolName: string): ApprovalRequest {
  return { toolName, description: `${toolName}(x)`, input: {} };
}

function scriptedQuestion(answers: readonly string[]): {
  question: (q: string) => Promise<string>;
  asked: string[];
} {
  const asked: string[] = [];
  let i = 0;
  return {
    asked,
    question: async (q: string) => {
      asked.push(q);
      const a = answers[i] ?? "";
      i += 1;
      return a;
    },
  };
}

describe("createApprover", () => {
  test("y approves, n denies, empty denies (safe default)", async () => {
    const { question } = scriptedQuestion(["y", "n", ""]);
    const approve = createApprover(question);
    expect(await approve(req("bash"))).toBe(true);
    expect(await approve(req("bash"))).toBe(false);
    expect(await approve(req("bash"))).toBe(false);
  });

  test("'a' allows and is remembered for that tool only", async () => {
    const { question, asked } = scriptedQuestion(["a", "y"]);
    const approve = createApprover(question);
    expect(await approve(req("file_write"))).toBe(true);
    // Same tool again: no question asked, auto-approved.
    expect(await approve(req("file_write"))).toBe(true);
    expect(asked.length).toBe(1);
    // Different tool still asks.
    expect(await approve(req("bash"))).toBe(true);
    expect(asked.length).toBe(2);
  });

  test("unrecognised answers deny", async () => {
    const { question } = scriptedQuestion(["sure", "ok!", "approve"]);
    const approve = createApprover(question);
    expect(await approve(req("bash"))).toBe(false);
    expect(await approve(req("bash"))).toBe(false);
    expect(await approve(req("bash"))).toBe(false);
  });
});
