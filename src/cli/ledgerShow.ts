/**
 * `alfred ledger show` — render a signed run ledger as a human table or a
 * Markdown table (`--md`) you can paste straight into a PR description.
 * The receipt is the product; this makes it shareable.
 *
 * Pure formatting over LedgerEntry rows — unit-tested.
 */
import type { LedgerEntry } from "../orchestrator/ledger.ts";

/** One-line summary of a ledger row's payload, per kind. */
export function summarizeEntry(e: LedgerEntry): string {
  const data = (e.data ?? {}) as Record<string, unknown>;
  if (e.kind === "feature") {
    const parts = [
      `${String(data.feature ?? "?")} ${String(data.status ?? "?")}`,
      `verify ${String(data.verifyExit ?? "?")}`,
      `rubric ${String(data.rubric ?? "—")}`,
    ];
    if (typeof data.reason === "string" && data.reason !== "") parts.push(data.reason);
    return parts.join(" · ");
  }
  if (e.kind === "run_end") {
    return `${String(data.passing ?? 0)} passing · ${String(data.blocked ?? 0)} blocked · ${String(
      data.stopped ?? "?",
    )}`;
  }
  return JSON.stringify(e.data);
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** Format rows as a terminal table, or a Markdown table when `md` is set. */
export function formatLedgerTable(rows: readonly LedgerEntry[], opts: { md?: boolean }): string {
  const cells = rows.map((e) => ({
    seq: String(e.seq),
    kind: e.kind,
    summary: summarizeEntry(e),
    time: new Date(e.ts).toISOString(),
    sig: `${e.sig.slice(0, 8)}…`,
  }));

  if (opts.md) {
    const lines = [
      "| seq | kind | summary | time | sig |",
      "| --- | --- | --- | --- | --- |",
      ...cells.map((c) => `| ${c.seq} | ${c.kind} | ${c.summary} | ${c.time} | \`${c.sig}\` |`),
    ];
    return lines.join("\n");
  }

  const w = {
    seq: Math.max(3, ...cells.map((c) => c.seq.length)),
    kind: Math.max(4, ...cells.map((c) => c.kind.length)),
    summary: Math.max(7, ...cells.map((c) => c.summary.length)),
  };
  const header = `${pad("seq", w.seq)}  ${pad("kind", w.kind)}  ${pad("summary", w.summary)}  sig`;
  const body = cells.map(
    (c) => `${pad(c.seq, w.seq)}  ${pad(c.kind, w.kind)}  ${pad(c.summary, w.summary)}  ${c.sig}`,
  );
  return [header, ...body].join("\n");
}
