/**
 * End-to-end test for the built-in offline demo (src/cli/demo.ts): the
 * scripted model drives the real harness in a temp sandbox — RED gate,
 * implement, gate exit 0, signed ledger verified, tamper drill caught —
 * and the command reports success. No API key, no network.
 */
import { describe, expect, test } from "bun:test";
import { runDemo } from "../src/cli/demo.ts";

describe("alfred demo", () => {
  test(
    "full offline run exits 0 (gate green, ledger intact, tamper caught)",
    async () => {
      expect(await runDemo()).toBe(0);
    },
    { timeout: 60_000 },
  );
});
