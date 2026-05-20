import { describe, test, expect } from "bun:test";
import { VERSION } from "../src/version.js";

describe("scaffold", () => {
  test("version is defined", () => {
    expect(VERSION).toBe("0.1.0");
  });

  test("version matches semver pattern", () => {
    const semver = /^\d+\.\d+\.\d+$/;
    expect(VERSION).toMatch(semver);
  });
});
