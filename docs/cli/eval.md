# alfred eval — regression harness

`alfred eval <file>` replays a recorded agent trajectory through the real query
engine and asserts that observable properties have not regressed. Only the LLM
provider is mocked; the full engine, permission, and tool stack run as in
production. Exits non-zero on any failure — suitable for CI.

```bash
alfred eval tests/my-evals.ts
alfred eval evals/index.js
```

## Module contract

The `<file>` argument must be a module that exports an `EvalCase[]` as its
**default export** (or as a named `cases` export). Alfred imports the file with
`import()` resolved relative to `process.cwd()`.

```ts
// my-evals.ts
import type { EvalCase } from "alfred/eval";  // re-exported from src/eval/types.ts
export default satisfies EvalCase[];
```

Both `.ts` and `.js` modules work under Bun.

## `EvalCase` fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | yes | Human-readable test name shown in the report |
| `prompt` | `string` | yes | The prompt fed to the agent for this case |
| `scripts` | `Script[]` | yes | Ordered MockProvider responses (see below) |
| `expect` | `EvalExpectation` | yes | Assertions to check after the run |

### `Script` union

Each entry in `scripts` is one of:

| Form | Description |
|------|-------------|
| `LLMResponse` | A canned response returned on the matching call |
| `Error` | Thrown to exercise the engine's retry path |
| `(messages, callIndex) => LLMResponse` | Function for dynamic responses |

The last script in the array **repeats** for any additional calls beyond the
script count — useful for capping an infinite loop.

### `EvalExpectation` fields

All fields are optional; omitting one skips that assertion.

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"success"` \| `"max_turns"` \| `"error"` \| … | The terminal `QueryState.status` the loop must produce |
| `toolsUsed` | `string[]` | Every tool in this list must appear in the observed `tool_use` events, **in this order** (not necessarily consecutively) |
| `toolCallCountAtMost` | `number` | Total number of `tool_use` events must not exceed this ceiling |
| `finalTextIncludes` | `string[]` | Each string must appear as a substring of the concatenated final assistant text |

## What a result looks like

`runEvalCase` returns an `EvalResult`:

```ts
interface EvalResult {
  name: string;
  passed: boolean;
  failures: string[];   // human-readable descriptions of every failed assertion
  toolsUsed: string[];  // tool names in call order
  status: QueryState["status"];
  turns: number;
}
```

`runEvalSuite` aggregates all results into an `EvalReport`:

```ts
interface EvalReport {
  total: number;
  passed: number;
  failed: number;
  results: EvalResult[];
}
```

## CLI output

The report is written to **stdout** in a compact text format:

```
Eval: 2/3 passed (1 failed)

  ✓ search-then-respond  [status=success, turns=2, tools=1]
  ✓ text-only-match      [status=success, turns=1, tools=0]
  ✗ wrong-expectations   [status=success, turns=1, tools=0]
      - status: expected "max_turns" but got "success"
      - toolsUsed: expected tool "grep" at or after index 0 in []
      - finalTextIncludes: expected substring "MISSING" not found in "hello world"
```

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | All cases passed (`report.failed === 0`) |
| `1` | One or more cases failed |

This makes `alfred eval` a drop-in CI step — it fails the build on regression.

## Complete example eval file

```ts
// evals/slugify.eval.ts
import { textResponse, toolUseResponse } from "../src/providers/mock.ts";
import type { EvalCase } from "../src/eval/types.ts";

const cases: EvalCase[] = [
  {
    name: "slugify: reads file then reports result",
    prompt: "Read src/strings/slugify.ts and tell me what it exports.",
    scripts: [
      // First LLM turn: the model decides to read the file
      toolUseResponse("file_read", { path: "src/strings/slugify.ts" }),
      // Second LLM turn: model produces the final answer
      textResponse("It exports a `slugify(s: string): string` function."),
    ],
    expect: {
      status: "success",
      toolsUsed: ["file_read"],
      toolCallCountAtMost: 1,
      finalTextIncludes: ["slugify", "string"],
    },
  },

  {
    name: "slugify: stays within turn budget on simple question",
    prompt: "What does a slug mean in web URLs?",
    scripts: [
      textResponse("A slug is the URL-friendly part of an address."),
    ],
    expect: {
      status: "success",
      toolCallCountAtMost: 0,
      finalTextIncludes: ["URL"],
    },
  },
];

export default cases;
```

Run it:

```bash
alfred eval evals/slugify.eval.ts
```

::: tip Use for CI regression gating
Add `alfred eval tests/evals.ts` as a step in your CI pipeline. Because it
exits non-zero on any failure it integrates directly with `bun test`,
GitHub Actions, and other runners without extra glue.
:::

::: info Only the provider is mocked
The full tool stack (file read/write, bash, glob, grep, etc.) executes as in
production. This catches regressions in tool dispatch, permission evaluation,
and the query loop — not just LLM behavior.
:::
