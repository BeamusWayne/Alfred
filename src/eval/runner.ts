/**
 * Eval harness runner — replay + assert regressions.
 *
 * ADR 0004 (eval harness — replay + assert regressions): runs a recorded
 * trajectory (MockProvider script set) through the REAL engine and checks each
 * EvalExpectation, collecting human-readable failures for CI regression gating.
 *
 * Only the provider is mocked; the full engine + permission + tool stack
 * executes as in production, ensuring regressions are caught before shipping.
 */
import { runQuery } from "../query/engine.ts";
import { MockProvider } from "../providers/mock.ts";
import type { QueryEvent, QueryState } from "../query/types.ts";
import type { EvalCase, EvalReport, EvalResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Drain the runQuery async generator, returning observed events + final state. */
async function drain(
  gen: AsyncGenerator<QueryEvent, QueryState>,
): Promise<{ readonly events: readonly QueryEvent[]; readonly state: QueryState }> {
  const events: QueryEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, state: next.value };
}

/** Extract tool names from tool_use events, preserving call order. */
function collectToolsUsed(events: readonly QueryEvent[]): readonly string[] {
  const names: string[] = [];
  for (const e of events) {
    if (e.type === "tool_use") {
      names.push(e.name);
    }
  }
  return names;
}

/** Collect the concatenated text from all "text" events (the final assistant output). */
function collectFinalText(events: readonly QueryEvent[]): string {
  return events
    .filter((e): e is Extract<QueryEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.text)
    .join("");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a single EvalCase through the real engine with a MockProvider and check
 * every EvalExpectation. Returns an EvalResult describing pass/fail + failures.
 */
export async function runEvalCase(c: EvalCase): Promise<EvalResult> {
  const provider = new MockProvider(c.scripts);
  const gen = runQuery(c.prompt, {
    provider,
    model: "mock",
    permissions: {
      mode: "bypass",
      allowedTools: new Set(),
      deniedTools: new Set(),
      workingDir: process.cwd(),
    },
  });

  const { events, state } = await drain(gen);
  const toolsUsed = collectToolsUsed(events);
  const finalText = collectFinalText(events);
  const failures: string[] = [];
  const { expect: exp } = c;

  // Assert terminal status.
  if (exp.status !== undefined && state.status !== exp.status) {
    failures.push(
      `status: expected "${exp.status}" but got "${state.status}"`,
    );
  }

  // Assert ordered tool subsequence: every tool in exp.toolsUsed must appear
  // in toolsUsed in the stated order (not necessarily consecutively).
  if (exp.toolsUsed !== undefined && exp.toolsUsed.length > 0) {
    let cursor = 0;
    for (const expected of exp.toolsUsed) {
      const idx = toolsUsed.indexOf(expected, cursor);
      if (idx === -1) {
        failures.push(
          `toolsUsed: expected tool "${expected}" at or after index ${cursor} ` +
            `in [${toolsUsed.join(", ")}]`,
        );
      } else {
        cursor = idx + 1;
      }
    }
  }

  // Assert tool call count ceiling.
  if (
    exp.toolCallCountAtMost !== undefined &&
    toolsUsed.length > exp.toolCallCountAtMost
  ) {
    failures.push(
      `toolCallCountAtMost: expected at most ${exp.toolCallCountAtMost} tool call(s) ` +
        `but observed ${toolsUsed.length}`,
    );
  }

  // Assert final text substrings.
  if (exp.finalTextIncludes !== undefined) {
    for (const substr of exp.finalTextIncludes) {
      if (!finalText.includes(substr)) {
        const preview =
          finalText.length > 120 ? `${finalText.slice(0, 120)}…` : finalText;
        failures.push(
          `finalTextIncludes: expected substring "${substr}" not found in "${preview}"`,
        );
      }
    }
  }

  return {
    name: c.name,
    passed: failures.length === 0,
    failures,
    toolsUsed,
    status: state.status,
    turns: state.turns,
  };
}

/**
 * Run all cases in the suite sequentially and aggregate results into an
 * EvalReport. Sequential execution keeps MockProvider state isolated per case.
 */
export async function runEvalSuite(
  cases: readonly EvalCase[],
): Promise<EvalReport> {
  const results: EvalResult[] = [];
  for (const c of cases) {
    results.push(await runEvalCase(c));
  }
  const passed = results.filter((r) => r.passed).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  };
}

/**
 * Format an EvalReport as a compact, human-readable text summary suitable for
 * CLI output. Each case gets a ✓ or ✗ prefix, and failures are indented below
 * the failing case.
 */
export function formatReport(report: EvalReport): string {
  const lines: string[] = [
    `Eval: ${report.passed}/${report.total} passed` +
      (report.failed > 0 ? ` (${report.failed} failed)` : ""),
    "",
  ];

  for (const r of report.results) {
    const icon = r.passed ? "✓" : "✗";
    lines.push(
      `  ${icon} ${r.name}  [status=${r.status}, turns=${r.turns}, tools=${r.toolsUsed.length}]`,
    );
    for (const f of r.failures) {
      lines.push(`      - ${f}`);
    }
  }

  return lines.join("\n");
}
