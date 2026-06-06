# Skills

Skills are Alfred's procedural memory: reusable, named instruction sets that live on disk and are loaded progressively — only what the model actually needs is pulled into the context window. This keeps the system prompt compact while making a rich library of capabilities available on demand.

## Three-level architecture

Alfred implements a three-level progressive-disclosure model (ADR 0001 §7.6):

| Level | What is loaded | When |
|---|---|---|
| **Level 1 — index** | Name + one-line description for every skill | Always, at agent start |
| **Level 2 — body** | Full `SKILL.md` text for one skill | On demand, via `load_skill` tool |
| **Level 3 — resources** | Files bundled inside the skill directory | Referenced from the body; read by the model using ordinary file tools |

This means ten skills add ten lines to the system prompt, not ten pages. The model reads the Level-1 index, decides which skill it needs, calls `load_skill`, and only then reads the full instructions.

## Directory layout

Skills live under `.alfred/skills/` in your project root. Each skill is a subdirectory containing at minimum a `SKILL.md` file. Level-3 resources are any additional files placed alongside it:

```
.alfred/
└── skills/
    ├── code-review/
    │   ├── SKILL.md           ← required: frontmatter + body
    │   ├── checklist.md       ← Level-3 resource (referenced from body)
    │   └── examples/
    │       └── bad-pattern.ts ← Level-3 resource
    └── generate-test/
        └── SKILL.md
```

The skill directory name has no semantic meaning to Alfred — only the `name` field in the frontmatter is used. However, the `load_skill` tool resolves Level-2 bodies by looking up `<skillsDir>/<name>/SKILL.md`, where `<name>` is the directory name you pass to the tool. Keep the directory name and the frontmatter `name` identical to avoid confusion.

## `SKILL.md` frontmatter

Every `SKILL.md` must begin with a `---`-delimited YAML frontmatter block containing exactly two required fields:

```markdown
---
name: code-review
description: Systematic code review: correctness, style, security, and test coverage
---

## Overview

Perform a structured review of the diff currently staged in git…
```

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` (non-empty) | Yes | Canonical skill name. Used in the Level-1 index and as the argument to `load_skill`. |
| `description` | `string` (non-empty) | Yes | One-line summary injected into every system prompt. Keep it short — this is all the model sees until it loads Level 2. |

Skills with a missing or blank `name` or `description` are silently skipped by the loader.

## Level-1 index injection

At startup `buildSystemContext` (in `src/context/index.ts`) calls `discoverSkills(join(workingDir, ".alfred", "skills"))` and passes the result to `renderSkillIndex`. The rendered block is injected into the system prompt _after_ project docs and agent memory but _before_ the repo map and volatile environment section, preserving prompt-cache stability.

The injected block looks like:

```
## Available skills

- **code-review** — Systematic code review: correctness, style, security, and test coverage
- **generate-test** — Generate a test file for a given source module using the project's test framework
```

If no valid skills are found, no `## Available skills` section appears in the prompt. A missing `.alfred/skills/` directory is gracefully treated as zero skills.

## The `load_skill` tool (Level 2)

When the model identifies a skill it needs, it calls the built-in `load_skill` tool:

```json
{
  "name": "load_skill",
  "input": { "name": "code-review" }
}
```

The tool resolves `<ctx.workingDir>/.alfred/skills/<name>/SKILL.md`, strips the frontmatter, and returns the body text to the model. The tool is flagged `isReadOnly: true` and `isConcurrencySafe: true`, so the engine can run it in parallel with other read-only tools.

If the named skill does not exist, the tool returns an error and suggests the model check the `## Available skills` index for valid names.

`load_skill` auto-allows without a permission prompt (it reads only files inside the project's `.alfred/skills/` directory).

## Complete example skill

`.alfred/skills/generate-test/SKILL.md`:

```markdown
---
name: generate-test
description: Generate a comprehensive test file for a source module using the project test framework
---

## When to use this skill

Use this skill when asked to write tests for a module, function, or class.
Load the skill before starting so you follow project conventions precisely.

## Steps

1. **Identify the module under test**
   - Read the source file fully before writing any test.
   - Note all exported symbols and their signatures.

2. **Check for an existing test file**
   - If one exists, extend it rather than replacing it.
   - If none exists, create `<source-basename>.test.ts` in the same directory.

3. **Apply the project test pattern**
   - Use `bun:test` (`describe`, `it`, `expect`) unless the project uses a different framework.
   - Each `describe` block covers one exported symbol.
   - Include: happy path, edge cases, error paths.
   - Aim for 80 %+ line coverage on the module.

4. **Run the tests to verify**
   - Execute `bun test <file>` and fix any failures before finishing.

## Example output shape

```ts
import { describe, it, expect } from "bun:test";
import { add } from "./math.ts";

describe("add", () => {
  it("returns the sum of two positive numbers", () => {
    expect(add(2, 3)).toBe(5);
  });

  it("handles negative operands", () => {
    expect(add(-1, 1)).toBe(0);
  });
});
```

## Level-3 resources in this skill

- `checklist.md` — edge-case checklist to consult before marking tests complete.
  Read it with the `read_file` tool: `.alfred/skills/generate-test/checklist.md`.
```

With this file in place, the Level-1 index shows one line. The model calls `load_skill("generate-test")` and receives the full body above. It can then use the `read_file` tool to fetch `checklist.md` if needed (a Level-3 resource).

## Loader internals

`discoverSkills(skillsDir)` in `src/skills/loader.ts`:
- Reads the top-level entries of `skillsDir` with `readdir`.
- For each entry, checks for `<entry>/SKILL.md`.
- Parses the frontmatter using a minimal `---` parser; validates against `SkillFrontmatterSchema` (Zod: both fields non-empty strings).
- Returns a `SkillMeta[]` (name, description, absolute path). Malformed skills are skipped; they do not cause errors.

`loadSkill(skillsDir, name)` in `src/skills/loader.ts`:
- Reads `<skillsDir>/<name>/SKILL.md`.
- Returns `{ meta: SkillMeta; body: string }` where `body` is everything below the closing `---`.
- Returns `null` when the file is absent or the frontmatter is invalid.

## Type reference

Defined in `src/skills/types.ts`:

```ts
interface SkillMeta {
  readonly name: string;
  readonly description: string;
  readonly path: string;   // absolute path to SKILL.md
}

interface Skill {
  readonly meta: SkillMeta;
  readonly body: string;   // SKILL.md content below the frontmatter
}
```
