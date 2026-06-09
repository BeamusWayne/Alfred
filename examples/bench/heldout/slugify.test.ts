// HELD-OUT test — the model never sees this during the bench. It is copied
// into the target only at check time (then removed) by runHeldOut().
import { test, expect } from "bun:test";
import { slugify } from "./src/slugify.ts";

test("basic example", () => {
  expect(slugify("Hello, World!")).toBe("hello-world");
});
test("collapses runs and trims", () => {
  expect(slugify("  Foo   Bar--Baz!! ")).toBe("foo-bar-baz");
});
test("empty string", () => {
  expect(slugify("")).toBe("");
});
test("already a slug is unchanged", () => {
  expect(slugify("already-a-slug")).toBe("already-a-slug");
});
test("leading/trailing punctuation stripped", () => {
  expect(slugify("!!!wow!!!")).toBe("wow");
});
