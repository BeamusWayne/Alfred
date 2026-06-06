# Writing a Custom Tool

Alfred exposes tools to the model via the `Tool` interface in
`src/tools/types.ts`. The `buildTool()` factory fills safe defaults for every
optional method, so you only implement what you need.

## The `Tool` interface

```ts
interface Tool<In extends z.ZodTypeAny, Out> {
  name:            string;
  description:     string;
  inputSchema:     In;

  call(input: z.output<In>, ctx: ToolContext): Promise<ToolResult<Out>>;

  isEnabled(): boolean;
  isReadOnly(input: z.output<In>): boolean;
  isConcurrencySafe(input: z.output<In>): boolean;
  checkPermissions(
    input: z.output<In>,
    ctx: ToolPermissionContext,
  ): Promise<PermissionResult>;
  describeCall(input: z.output<In>): string;
  render(result: ToolResult<Out>): readonly ContentBlock[];
}
```

`buildTool()` supplies these defaults when you omit them:

| Method | Default |
|---|---|
| `isEnabled` | `() => true` |
| `isReadOnly` | `() => false` — conservative; write-unsafe |
| `isConcurrencySafe` | `() => false` — runs serially |
| `checkPermissions` | `async () => allow()` — always allow |
| `describeCall` | `() => tool.name` |
| `render` | serialises `content` as a text block |

## Step 1 — Define the input schema with Zod

```ts
import { z } from "zod";

const inputSchema = z.object({
  query:   z.string().describe("Search query"),
  limit:   z.number().int().positive().max(50).default(10)
            .describe("Maximum results to return"),
  include: z.array(z.string()).optional()
            .describe("File globs to include"),
});
```

The Zod schema serves triple duty: it validates incoming model-supplied JSON,
generates the JSON Schema that is sent to the model in the tool definition, and
narrows the TypeScript type of `input` inside `call()`.

## Step 2 — Declare capability flags

Capability flags let the engine schedule tools efficiently without guessing:

```ts
isReadOnly: () => true,        // safe to run in parallel; no filesystem writes
isConcurrencySafe: () => true, // safe to interleave with other read-only calls
```

Read-only AND concurrency-safe tools run in parallel. Any other combination
serialises. When in doubt, leave both as `false` (the default) — it is safe
but slower.

## Step 3 — Implement `checkPermissions`

Return one of `allow()`, `ask(reason)`, or `deny(reason)` from
`src/permissions/types.ts`:

```ts
import { allow, ask, deny } from "../permissions/types.ts";
import type { ToolPermissionContext } from "../permissions/types.ts";

checkPermissions: async (input, ctx: ToolPermissionContext) => {
  // Hard deny: never allow writes outside the workspace
  if (!input.path.startsWith(ctx.workingDir)) {
    return deny("path escapes the workspace");
  }
  // Ask the user unless they chose bypass/acceptEdits
  if (ctx.mode === "default" || ctx.mode === "plan") {
    return ask(`search ${input.query} in ${input.path}`);
  }
  return allow();
},
```

`ctx.mode` is one of `"default"` | `"acceptEdits"` | `"plan"` | `"bypass"`.

## Step 4 — Implement `call`

```ts
import type { ToolResult, ToolContext } from "./types.ts";

call: async (input, ctx: ToolContext): Promise<ToolResult<string>> => {
  // ctx.workingDir  — absolute project root
  // ctx.signal      — AbortSignal (respect it in long-running ops)
  // ctx.readFileState — last-read snapshot map for read-before-write checks
  // ctx.permissions — ToolPermissionContext (same as checkPermissions receives)

  try {
    const results = await mySearchLibrary(input.query, {
      cwd:    ctx.workingDir,
      limit:  input.limit,
      signal: ctx.signal,
    });
    return { content: results.join("\n") };
  } catch (err) {
    return {
      content: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
},
```

Always return `{ content, isError: true }` for errors rather than throwing.
This surfaces the failure to the model so it can retry or change approach.

### Marking untrusted content

If your tool fetches content from external sources (web pages, third-party
APIs) mark the result `untrusted: true`. Alfred uses this flag for taint
tracking (ADR 0003):

```ts
return { content: fetchedHtml, untrusted: true };
```

## Step 5 — Assemble the tool with `buildTool`

```ts
import { z } from "zod";
import { buildTool } from "./types.ts";
import { allow, ask, deny } from "../permissions/types.ts";

const inputSchema = z.object({
  query: z.string().describe("Ripgrep pattern"),
  path:  z.string().optional().describe("Directory to search (default: workspace root)"),
});

export const ripgrepTool = buildTool({
  name:        "ripgrep",
  description: "Fast regex search via rg. Returns file:line:match lines.",
  inputSchema,

  isReadOnly:        () => true,
  isConcurrencySafe: () => true,

  describeCall: (input) => `ripgrep(${input.query})`,

  checkPermissions: async (_input, _ctx) => allow(),

  call: async (input, ctx) => {
    const cwd  = input.path ?? ctx.workingDir;
    const proc = Bun.spawn(
      ["rg", "--line-number", "--max-count=200", input.query, cwd],
      { stdout: "pipe", stderr: "pipe", signal: ctx.signal },
    );

    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;

    if (proc.exitCode === 0) return { content: out.trim() || "(no matches)" };
    if (proc.exitCode === 1) return { content: "(no matches)" };
    return { content: `rg error: ${err.trim()}`, isError: true };
  },
});
```

## Step 6 — Register the tool in `src/tools/index.ts`

Open `src/tools/index.ts` and add your tool to the `BUILTIN` array:

```ts
import { ripgrepTool } from "./ripgrep.ts";   // ← add this import

const BUILTIN: readonly Tool[] = [
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  bashTool,
  globTool,
  grepTool,
  memorySearchTool,
  memoryUpsertTool,
  memoryForgetTool,
  webFetchTool,
  skillTool,
  ripgrepTool,   // ← add here
];
```

`getAllTools()` filters by `isEnabled()`, so a tool can gate itself on
environment conditions without being removed from the list.

## Complete example — `src/tools/ripgrep.ts`

```ts
import { z } from "zod";
import { buildTool } from "./types.ts";
import type { ToolResult, ToolContext } from "./types.ts";
import { allow } from "../permissions/types.ts";

const inputSchema = z.object({
  query:     z.string().describe("Regex pattern passed to rg"),
  path:      z.string().optional().describe("Root directory (default: workspace)"),
  maxCount:  z.number().int().positive().max(500).default(200)
              .describe("Cap on returned matches"),
  ignoreCase: z.boolean().optional().describe("Case-insensitive search"),
});

export const ripgrepTool = buildTool({
  name: "ripgrep",
  description:
    "Fast recursive regex search via the rg binary. " +
    "Returns file:line:match lines, capped at maxCount.",
  inputSchema,

  isEnabled:         () => true,
  isReadOnly:        () => true,
  isConcurrencySafe: () => true,

  checkPermissions: async () => allow(),

  describeCall: (input) =>
    `ripgrep(${input.query}${input.path ? ` in ${input.path}` : ""})`,

  call: async (input, ctx: ToolContext): Promise<ToolResult<string>> => {
    const searchRoot = input.path ?? ctx.workingDir;
    const args: string[] = [
      "--line-number",
      `--max-count=${input.maxCount}`,
      ...(input.ignoreCase ? ["--ignore-case"] : []),
      input.query,
      searchRoot,
    ];

    const proc = Bun.spawn(["rg", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    // Respect AbortSignal for cancellation.
    const onAbort = () => proc.kill();
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text().catch(() => ""),
      new Response(proc.stderr).text().catch(() => ""),
    ]);
    await proc.exited;
    ctx.signal.removeEventListener("abort", onAbort);

    switch (proc.exitCode) {
      case 0:  return { content: stdout.trim() || "(no matches)" };
      case 1:  return { content: "(no matches)" };
      default: return {
        content: `rg exited ${proc.exitCode}: ${stderr.trim()}`,
        isError: true,
      };
    }
  },
});
```

## Testing your tool

Write the test before the implementation (see the TDD workflow in the global
rules). Here is a minimal test using Bun's built-in test runner:

```ts
// tests/ripgrep.test.ts
import { describe, it, expect } from "bun:test";
import { ripgrepTool } from "../src/tools/ripgrep.ts";
import type { ToolContext } from "../src/tools/types.ts";

const ctx: ToolContext = {
  workingDir:    process.cwd(),
  signal:        new AbortController().signal,
  readFileState: new Map(),
  permissions: {
    mode:         "bypass",
    allowedTools: new Set(),
    deniedTools:  new Set(),
    workingDir:   process.cwd(),
  },
};

describe("ripgrepTool", () => {
  it("returns matches for a known pattern", async () => {
    const result = await ripgrepTool.call(
      { query: "buildTool", maxCount: 200 },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("buildTool");
  });

  it("returns no-matches sentinel on zero results", async () => {
    const result = await ripgrepTool.call(
      { query: "PATTERN_THAT_DEFINITELY_DOES_NOT_EXIST_xyz123" },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("(no matches)");
  });

  it("is read-only and concurrency-safe", () => {
    expect(ripgrepTool.isReadOnly({ query: "x" })).toBe(true);
    expect(ripgrepTool.isConcurrencySafe({ query: "x" })).toBe(true);
  });
});
```

```bash
bun test tests/ripgrep.test.ts
```

::: tip isEnabled for optional tools
If your tool depends on an external binary that may not be installed, guard
`isEnabled` with a runtime check:

```ts
isEnabled: () => {
  try {
    Bun.spawnSync(["rg", "--version"]);
    return true;
  } catch {
    return false;
  }
},
```

`getAllTools()` filters out disabled tools before sending the list to the model.
:::
