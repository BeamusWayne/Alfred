/**
 * Interactive tool approval — completes the permission stack's "ask" loop.
 *
 * The engine's `ask` behavior denies when no approver is wired (engine.ts:
 * "no approver"); before 0.3.0 the CLI only offered the all-or-nothing
 * `--yes`. This module turns "ask" into a real question on a TTY:
 *
 *   ⚠ approve <tool description>? [y/N/a]   (a = always allow this tool)
 *
 * The decision logic is pure (`createApprover`) so it can be unit-tested;
 * the stdin wiring (`stdinQuestion`) is the only IO.
 */
import * as readline from "node:readline";
import type { ApprovalRequest } from "../query/types.ts";
import { palette } from "./colors.ts";

export type QuestionFn = (q: string) => Promise<string>;
export type Approver = (req: ApprovalRequest) => Promise<boolean>;

/**
 * Build an approver from a question function. Session-scoped "always allow"
 * answers are remembered per tool name. Anything other than y/yes/a/always
 * (case-insensitive) denies — denial is the safe default.
 */
export function createApprover(question: QuestionFn): Approver {
  const alwaysAllowed = new Set<string>();
  const c = palette(process.stderr);

  return async (req: ApprovalRequest): Promise<boolean> => {
    if (alwaysAllowed.has(req.toolName)) return true;
    const reason = req.reason ? ` ${c.dim(`(${req.reason})`)}` : "";
    const answer = (
      await question(`${c.yellow("⚠ approve")} ${req.description}?${reason} [y/N/a] `)
    )
      .trim()
      .toLowerCase();
    if (answer === "a" || answer === "always") {
      alwaysAllowed.add(req.toolName);
      return true;
    }
    return answer === "y" || answer === "yes";
  };
}

/**
 * One-shot stdin question for non-REPL runs: a throwaway readline interface
 * per approval, writing the prompt to stderr so stdout stays a clean answer
 * stream.
 */
export const stdinQuestion: QuestionFn = (q) =>
  new Promise((resolveAnswer) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(q, (answer) => {
      rl.close();
      resolveAnswer(answer);
    });
  });

/**
 * The CLI-level approver for one-shot runs: auto-approve under `--yes`,
 * interactive on a TTY, and absent otherwise (the engine then denies with
 * actionable guidance).
 */
export function resolveApprover(yes: boolean | undefined): Approver | undefined {
  if (yes) return async () => true;
  if (process.stdin.isTTY && process.stderr.isTTY) return createApprover(stdinQuestion);
  return undefined;
}
