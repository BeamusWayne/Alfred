// HELD-OUT test — the model never sees this during the bench. It is copied
// into the target only at check time (then removed) by runHeldOut().
import { test, expect } from "bun:test";
import { truncate } from "./src/truncate.ts";

test("shorter than max is unchanged", () => {
  expect(truncate("hi", 5)).toBe("hi");
});
test("exactly max is unchanged", () => {
  expect(truncate("hello", 5)).toBe("hello");
});
test("longer than max gets first max chars + ellipsis", () => {
  expect(truncate("hello world", 5)).toBe("hello…");
});
test("max zero", () => {
  expect(truncate("abc", 0)).toBe("…");
});
