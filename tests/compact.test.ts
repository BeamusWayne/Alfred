import { describe, test, expect } from "bun:test";
import {
  estimateTokens,
  shouldCompact,
  compactMessages,
  type CompactableMessage,
} from "../src/compact/engine.js";

describe("token estimation", () => {
  test("estimate tokens for text", () => {
    const tokens = estimateTokens("Hello, world!");
    expect(tokens).toBeGreaterThan(0);
  });

  test("longer text has more tokens", () => {
    const short = estimateTokens("Hi");
    const long = estimateTokens("This is a much longer sentence with many more words.");
    expect(long).toBeGreaterThan(short);
  });

  test("empty string has 0 tokens", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("should compact", () => {
  const messages: CompactableMessage[] = [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there!" },
    { role: "user", content: "How are you?" },
    { role: "assistant", content: "I'm doing well!" },
  ];

  test("returns false when under threshold", () => {
    expect(shouldCompact(messages, 10000)).toBe(false);
  });

  test("returns true when over threshold", () => {
    expect(shouldCompact(messages, 5)).toBe(true);
  });
});

describe("compact messages", () => {
  test("keep recent messages, summarize older ones", () => {
    const messages: CompactableMessage[] = [
      { role: "user", content: "First question about Python" },
      { role: "assistant", content: "Python is great for scripting." },
      { role: "user", content: "Second question about TypeScript" },
      { role: "assistant", content: "TypeScript adds types to JavaScript." },
      { role: "user", content: "Third question about Rust" },
      { role: "assistant", content: "Rust is fast and safe." },
    ];

    const result = compactMessages(messages, { keepRecent: 2 });
    expect(result.summary).toBeDefined();
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.kept.length).toBe(2);
    expect(result.kept[0].content).toContain("Rust");
  });

  test("handle small message list", () => {
    const messages: CompactableMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!" },
    ];

    const result = compactMessages(messages, { keepRecent: 2 });
    expect(result.kept.length).toBe(2);
    expect(result.summary).toBe("");
  });

  test("handle empty messages", () => {
    const result = compactMessages([], { keepRecent: 2 });
    expect(result.kept).toEqual([]);
    expect(result.summary).toBe("");
  });
});
