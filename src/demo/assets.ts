/**
 * On-disk fixtures for the built-in offline demo: a RED project (a failing
 * test and a pending feature_list) that `alfred demo` scaffolds into a
 * temporary directory. The scripted model then implements `add()`, the real
 * gate captures exit 0, and the signed ledger records it.
 */

export const DEMO_ADD_TEST_TS = [
  'import { test, expect } from "bun:test";',
  'import { add } from "./add.ts";',
  "",
  'test("add sums two numbers", () => {',
  "  expect(add(2, 3)).toBe(5);",
  "});",
  "",
].join("\n");

export const DEMO_FEATURE_LIST = {
  features: [
    {
      id: "demo-add",
      title: "Implement add()",
      description:
        "Create add.ts exporting add(a: number, b: number): number that returns the sum, so add.test.ts passes.",
      status: "pending",
    },
  ],
} as const;

export const DEMO_VERIFY_CMD = "bun test add.test.ts";
