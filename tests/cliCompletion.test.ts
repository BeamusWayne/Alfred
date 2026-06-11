/**
 * Tests for `alfred completion` (src/cli/completion.ts): both shells emit a
 * script that mentions every command.
 */
import { describe, expect, test } from "bun:test";
import { completionScript } from "../src/cli/completion.ts";

const COMMANDS = ["run", "eval", "ledger", "status", "demo", "init", "why", "completion"];

describe("completionScript", () => {
  test("bash uses complete -W with every command", () => {
    const out = completionScript("bash", COMMANDS);
    expect(out).toContain("complete -W");
    for (const cmd of COMMANDS) expect(out).toContain(cmd);
  });

  test("zsh defines and registers _alfred", () => {
    const out = completionScript("zsh", COMMANDS);
    expect(out).toContain("compdef _alfred alfred");
    for (const cmd of COMMANDS) expect(out).toContain(cmd);
    expect(out).toContain("--permission-mode");
  });
});
