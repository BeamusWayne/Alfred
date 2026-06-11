import { test, expect } from "bun:test";
import { add } from "./add.ts";

test("add sums two numbers", () => {
  expect(add(2, 3)).toBe(5);
});
