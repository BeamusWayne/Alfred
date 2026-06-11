# alfred watch — follow a run live

`alfred run` is built to be left alone. `alfred watch` is how you look at it
without touching it: a **read-only live panel** over the run's on-disk record
— the same `journal.jsonl` + `ledger.jsonl` the run signs. Watching is
reading the receipt as it is written.

```bash
alfred watch                       # latest run under .alfred/workflows
alfred watch <runDir>              # a specific run directory
alfred watch <path/to/ledger.jsonl>
```

## What it shows

One line per recorded event, as it lands — including live tool beats while
an agent works (journal `activity` rows, written in real time):

```
· watching 2026-06-11T07-24-58-080Z
  ⚙ read(add.test.ts)                          ← live tool beats
  ⚙ write(add.ts)
  ⚙ bash(bun test add.test.ts)
⚙ implement:demo-add#1 ✓ · $0.0028 · 4 turns   ← journal: agent finished
  ⚙ glob(add.ts)
  ⚙ structured_output
⚙ rubric:demo-add ✓ · $0.0012 · 3 turns
✓ demo-add passing · verify exit 0 · rubric 2   ← ledger: feature receipt
run end: 1 passing · 0 blocked · all_resolved   ← ledger: run end
```

plus a sticky footer block, redrawn in place on stderr (TTY only):

```
▮▮▮▯▯▯▯▯▯▯ 1/3 features · ⏱ 2:14 · $0.0212
▸ implement:auth#2 · bash(bun test)
```

`alfred run` itself wears the same face: the run terminal shows the beats
and the footer live, no second terminal required.

Event lines go to stdout, the status line to stderr — so
`alfred watch | tee progress.log` captures clean lines. Off-TTY (or with
`NO_COLOR`) the panel degrades to plain appended lines, no redraws.

Feature progress (`1/3`) is read from `feature_list.json` in the working
directory when one is present; otherwise the panel shows resolved counts
only.

## Attach early, replay late

- **Live**: attach from a second terminal at any point — even before the
  run's first write (`journal.jsonl`/`ledger.jsonl` are created lazily;
  watch waits for them to appear). It follows until the ledger records
  `run_end`, then exits 0.
- **Replay**: pointed at a finished run, the same renderer prints the whole
  record and exits immediately.

## Why not a TUI?

Deliberate. No alternate screen, no input handling, no new dependencies —
the panel is a *renderer over signed facts*. Every line it prints corresponds
to a row `alfred ledger verify` can later prove intact. Interactive work
belongs to the REPL (bare `alfred`); unattended runs belong to `alfred run`,
with `watch`, [`why`](/cli/overview) and
[`ledger show`](/cli/ledger) as the read-only audit surfaces.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | the run ended (`run_end` recorded), live or replayed |
| 1 | nothing to watch (no run directory found) |
| 130 | interrupted (Ctrl-C) |
