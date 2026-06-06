/**
 * Fuzzy locate for the edit tool (ADR 0001 §7.2, after Codex `seek_sequence`).
 *
 * Edits should locate by *content*, never line numbers, and tolerate the
 * whitespace drift that makes naive `includes()` matching brittle. We try a
 * ladder of increasingly forgiving comparators and stop at the first that
 * yields exactly one match, returning the precise char span to replace.
 */

export type LocateStrategy = "exact" | "rstrip" | "trim" | "collapse";

export interface Located {
  readonly start: number;
  readonly end: number;
  readonly strategy: LocateStrategy;
  /** How many places this needle matched under the winning strategy. */
  readonly count: number;
}

interface LineSpan {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function splitLines(s: string): LineSpan[] {
  const out: LineSpan[] = [];
  let start = 0;
  for (let i = 0; i <= s.length; i++) {
    if (i === s.length || s[i] === "\n") {
      out.push({ text: s.slice(start, i), start, end: i });
      start = i + 1;
    }
  }
  return out;
}

const NORMALIZERS: Record<Exclude<LocateStrategy, "exact">, (line: string) => string> = {
  rstrip: (l) => l.replace(/\s+$/, ""),
  trim: (l) => l.trim(),
  collapse: (l) => l.trim().replace(/\s+/g, " "),
};

function findLineRuns(
  haystack: LineSpan[],
  needle: string[],
  norm: (l: string) => string,
): Array<{ start: number; end: number }> {
  const hits: Array<{ start: number; end: number }> = [];
  const need = needle.map(norm);
  for (let i = 0; i + need.length <= haystack.length; i++) {
    let ok = true;
    for (let j = 0; j < need.length; j++) {
      if (norm(haystack[i + j]!.text) !== need[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      hits.push({ start: haystack[i]!.start, end: haystack[i + need.length - 1]!.end });
    }
  }
  return hits;
}

/**
 * Find `needle` inside `haystack`. Returns the unique match span, or `null` if
 * there is no match or more than one (callers should treat ambiguity as an
 * error rather than guessing).
 */
export function locate(haystack: string, needle: string): Located | null {
  if (needle.length === 0) return null;

  // 1. Exact — count occurrences to detect ambiguity.
  let idx = haystack.indexOf(needle);
  if (idx !== -1) {
    const second = haystack.indexOf(needle, idx + 1);
    if (second === -1) {
      return { start: idx, end: idx + needle.length, strategy: "exact", count: 1 };
    }
    return { start: idx, end: idx + needle.length, strategy: "exact", count: 2 };
  }

  // 2. Line-based ladder for whitespace-drifted blocks.
  const hLines = splitLines(haystack);
  const nLines = needle.split("\n");
  for (const strategy of ["rstrip", "trim", "collapse"] as const) {
    const hits = findLineRuns(hLines, nLines, NORMALIZERS[strategy]);
    if (hits.length === 1) {
      return { start: hits[0]!.start, end: hits[0]!.end, strategy, count: 1 };
    }
    if (hits.length > 1) {
      return { start: hits[0]!.start, end: hits[0]!.end, strategy, count: hits.length };
    }
  }
  return null;
}
