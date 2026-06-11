/**
 * Tests for src/orchestrator/workflows/bestOfN.ts.
 *
 * ADR 0001 §5.4 (best-of-N, objective reward / inference-time scaling).
 *
 * Uses MockProvider with function scripts keyed on call index so each simulated
 * candidate returns a distinct structured output. The scorer is fully
 * deterministic — no randomness, no I/O — verifying the general best-of-N
 * primitive end-to-end with a real Runtime.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { AgentRun } from "../src/orchestrator/agent.ts";
import { createRuntime } from "../src/orchestrator/runtime.ts";
import { bestOfN } from "../src/orchestrator/workflows/bestOfN.ts";
import { MockProvider, textResponse, toolUseResponse } from "../src/providers/mock.ts";

// ---------------------------------------------------------------------------
// Shared schema + types
// ---------------------------------------------------------------------------

const solutionSchema = z.object({
  value: z.number(),
  label: z.string(),
});
type Solution = z.infer<typeof solutionSchema>;

// ---------------------------------------------------------------------------
// Runtime factory
// ---------------------------------------------------------------------------

/**
 * Build a minimal Runtime wired to the given MockProvider.
 * permissions.mode "bypass" — no interactive approval needed in tests.
 */
function makeRuntime(provider: MockProvider) {
  return createRuntime("test-run", {
    provider,
    model: "mock",
    permissions: {
      mode: "bypass",
      allowedTools: new Set<string>(),
      deniedTools: new Set<string>(),
      workingDir: "/tmp",
    },
  });
}

// ---------------------------------------------------------------------------
// Scorer: prefer the candidate with the highest `value` field
// ---------------------------------------------------------------------------

function scoreByValue(candidate: Solution, _run: AgentRun<Solution>): number {
  return candidate.value;
}

// ---------------------------------------------------------------------------
// Happy path: pick the highest-scoring candidate
// ---------------------------------------------------------------------------

describe("bestOfN — selects highest-scoring candidate", () => {
  test("returns the candidate with the highest score, candidates.length === n", async () => {
    // Three candidates with values 10, 30, 20. Expect winner = index 1 (value=30).
    const candidates: Solution[] = [
      { value: 10, label: "alpha" },
      { value: 30, label: "beta" }, // winner
      { value: 20, label: "gamma" },
    ];

    // The engine calls MockProvider once per agent turn.  Each bestOfN candidate
    // produces exactly one turn: structured_output tool call → done.
    // MockProvider's script function receives the global call index, so we
    // rotate through candidates[0..2] across the 3 parallel agent calls.
    const provider = new MockProvider([
      (_msgs, callIndex) =>
        toolUseResponse("structured_output", candidates[callIndex % candidates.length]!),
      // Repeat the last script automatically (MockProvider clamps at scripts.length-1).
    ]);

    const runtime = makeRuntime(provider);
    const result = await bestOfN<Solution>({
      runtime,
      n: 3,
      prompt: "Produce a solution.",
      schema: solutionSchema,
      score: scoreByValue,
    });

    expect(result.candidates).toHaveLength(3);
    expect(result.bestScore).toBe(30);
    expect(result.best).toEqual({ value: 30, label: "beta" });
  });
});

// ---------------------------------------------------------------------------
// Tie-breaking: lowest index wins
// ---------------------------------------------------------------------------

describe("bestOfN — ties resolve to lowest index", () => {
  test("when two candidates share the top score, the first (index 0) wins", async () => {
    // Candidates: value 50 at index 0, then value 50 at index 1.
    // Both tie; index 0 must win.
    const tiedCandidates: Solution[] = [
      { value: 50, label: "first" },
      { value: 50, label: "second" },
    ];

    const provider = new MockProvider([
      (_msgs, callIndex) =>
        toolUseResponse("structured_output", tiedCandidates[callIndex % tiedCandidates.length]!),
    ]);

    const runtime = makeRuntime(provider);
    const result = await bestOfN<Solution>({
      runtime,
      n: 2,
      prompt: "Produce a solution.",
      schema: solutionSchema,
      score: scoreByValue,
    });

    expect(result.candidates).toHaveLength(2);
    expect(result.bestScore).toBe(50);
    // The first candidate to reach score 50 wins (lowest index = 0).
    expect(result.best).toEqual({ value: 50, label: "first" });
  });
});

// ---------------------------------------------------------------------------
// All-null case: every candidate fails to produce structured output
// ---------------------------------------------------------------------------

describe("bestOfN — all candidates null", () => {
  test("best is null and bestScore is -Infinity when all agents return null data", async () => {
    // Simulate the model ignoring the tool and returning plain text — runAgent
    // will set data=null when JSON.parse fails or the tool is never called.
    const provider = new MockProvider([textResponse("I refuse to produce structured output.")]);

    const runtime = makeRuntime(provider);
    const result = await bestOfN<Solution>({
      runtime,
      n: 3,
      prompt: "Produce a solution.",
      schema: solutionSchema,
      score: scoreByValue,
    });

    expect(result.candidates).toHaveLength(3);
    expect(result.best).toBeNull();
    expect(result.bestScore).toBe(-Infinity);

    // Every candidate entry should have data=null and score=-Infinity.
    for (const c of result.candidates) {
      expect(c.data).toBeNull();
      expect(c.score).toBe(-Infinity);
    }
  });
});

// ---------------------------------------------------------------------------
// Mixed null/non-null: non-null candidate wins even if it has a low score
// ---------------------------------------------------------------------------

describe("bestOfN — mixed null and non-null candidates", () => {
  test("non-null candidate wins over null candidates regardless of score", async () => {
    // candidate 0 → null (plain text), candidate 1 → value=1, candidate 2 → null
    const validCandidate: Solution = { value: 1, label: "only-valid" };

    const provider = new MockProvider([
      (_msgs, callIndex) => {
        if (callIndex === 1) {
          return toolUseResponse("structured_output", validCandidate);
        }
        return textResponse("not structured");
      },
    ]);

    const runtime = makeRuntime(provider);
    const result = await bestOfN<Solution>({
      runtime,
      n: 3,
      prompt: "Produce a solution.",
      schema: solutionSchema,
      score: scoreByValue,
    });

    expect(result.candidates).toHaveLength(3);
    expect(result.best).toEqual(validCandidate);
    expect(result.bestScore).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Async scorer: scorer returning a Promise is awaited correctly
// ---------------------------------------------------------------------------

describe("bestOfN — async scorer", () => {
  test("supports a scorer that returns a Promise", async () => {
    const candidates: Solution[] = [
      { value: 5, label: "low" },
      { value: 99, label: "high" }, // winner
    ];

    const provider = new MockProvider([
      (_msgs, callIndex) =>
        toolUseResponse("structured_output", candidates[callIndex % candidates.length]!),
    ]);

    const runtime = makeRuntime(provider);
    // Async scorer: wraps the value in a resolved Promise.
    const asyncScore = async (c: Solution): Promise<number> => {
      return Promise.resolve(c.value);
    };

    const result = await bestOfN<Solution>({
      runtime,
      n: 2,
      prompt: "Produce a solution.",
      schema: solutionSchema,
      score: asyncScore,
    });

    expect(result.best).toEqual({ value: 99, label: "high" });
    expect(result.bestScore).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// labelPrefix option
// ---------------------------------------------------------------------------

describe("bestOfN — labelPrefix option", () => {
  test("defaults to 'best-of-n' and still works correctly", async () => {
    const candidate: Solution = { value: 7, label: "x" };
    const provider = new MockProvider([toolUseResponse("structured_output", candidate)]);

    const runtime = makeRuntime(provider);
    const result = await bestOfN<Solution>({
      runtime,
      n: 1,
      prompt: "Produce a solution.",
      schema: solutionSchema,
      score: scoreByValue,
      // no labelPrefix supplied → uses default
    });

    expect(result.best).toEqual(candidate);
    expect(result.candidates).toHaveLength(1);
  });
});
