# Writing a Skill

Skills are Alfred's **procedural memory**: reusable, project-local playbooks
that the model can load on demand. They live in
`.alfred/skills/<name>/SKILL.md` and are surfaced to the model in two layers.

## The three-level skill system (ADR 0001 §7.6)

| Level | What the model sees | When |
|---|---|---|
| Level 1 — index | `name` + `description` for every skill | Always, in the system prompt |
| Level 2 — body | Full `SKILL.md` body for one skill | When the model calls `load_skill` |
| Level 3 — resources | Files referenced inside the skill body | When the model reads them via `file_read` or `bash` |

This progressive-disclosure design keeps context small: the model holds a
compact index at all times, then fetches only the skills it actually needs.

## Skill directory layout

```
.alfred/
  skills/
    deploy/
      SKILL.md          ← the skill file (frontmatter + body)
      checklist.md      ← bundled Level-3 resource (optional)
      schema.json       ← another bundled resource (optional)
    smoke-test/
      SKILL.md
```

Each skill lives in its own subdirectory. The subdirectory name is the
filesystem key; `name` in the frontmatter is the label the model uses.

## `SKILL.md` format

```markdown
---
name: deploy
description: Run the full deploy pipeline: build, push image, update Helm chart, smoke-test.
---

## Overview

This skill deploys the service to the staging or production cluster.
…
```

### Frontmatter fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `name` | non-empty string | yes | The `load_skill` argument the model uses |
| `description` | non-empty string | yes | One-line summary injected into the Level-1 index |

Both fields are validated by `SkillFrontmatterSchema` (a Zod schema). A skill
with missing or blank `name` or `description` is silently skipped during
discovery — no error is raised, but it will not appear in the index.

The YAML parser is intentionally minimal: it splits on the first `:` on each
line inside the `---` block. Keep values on a single line without quotes. Do
not use nested YAML.

### Body

Everything below the closing `---` line is the body. It is returned verbatim
by the `load_skill` tool. Use Markdown — the model receives it as plain text
but markdown structure aids readability.

## Level-1 index injection

`discoverSkills()` scans `.alfred/skills/` on every agent start and builds the
index. `renderSkillIndex()` produces a compact block that is injected into the
system prompt:

```
## Available skills

- **deploy** — Run the full deploy pipeline: build, push image, update Helm chart, smoke-test.
- **smoke-test** — Run the smoke-test suite against a live endpoint.
```

The model sees this block in every prompt. It knows which skills exist without
loading any skill body.

## Level-2 on-demand loading

When the model needs the full instructions for a skill it calls the built-in
`load_skill` tool:

```json
{ "name": "deploy" }
```

The tool reads `.alfred/skills/deploy/SKILL.md` and returns the body. The body
is then added to the context for the current turn.

## Level-3 bundled resources

Reference supporting files inside the skill body using relative paths. The
model can then read them with `file_read` or include them in `bash` commands:

```markdown
## Checklist

Before deploying, review `.alfred/skills/deploy/checklist.md`.

## Schema

The Helm values schema is at `.alfred/skills/deploy/schema.json`.
Run `bun run scripts/validate-helm.ts .alfred/skills/deploy/schema.json`
to validate your values file.
```

## Complete example — `smoke-test` skill

### Directory

```
.alfred/
  skills/
    smoke-test/
      SKILL.md
      endpoints.json
```

### `SKILL.md`

```markdown
---
name: smoke-test
description: Run smoke tests against a live URL — checks status codes, response shapes, and latency.
---

## Purpose

Verify that a freshly deployed service is responding correctly before marking
the deployment successful.

## Steps

1. Read the endpoint list from `.alfred/skills/smoke-test/endpoints.json`.
2. For each endpoint, run:
   ```bash
   curl -s -o /dev/null -w "%{http_code} %{time_total}" <url>
   ```
3. Assert:
   - HTTP status in the expected set (usually 200, 201, or 204).
   - Response time under 2 000 ms.
4. If any assertion fails, report which endpoints failed and their actual
   values, then exit with a non-zero code.

## Inputs

| Variable | Description |
|---|---|
| `BASE_URL` | Base URL of the deployed service (e.g. `https://staging.example.com`) |

## Example

```bash
BASE_URL=https://staging.example.com bun run scripts/smoke.ts
```

## Failure handling

- Retry each endpoint once before marking it failed.
- Collect all failures and report them together (do not fail fast on the first
  error so all problems are visible in one run).
```

### `endpoints.json` (bundled resource)

```json
[
  { "path": "/health",   "expectedStatus": 200, "maxMs": 500  },
  { "path": "/api/v1",   "expectedStatus": 200, "maxMs": 2000 },
  { "path": "/metrics",  "expectedStatus": 200, "maxMs": 1000 }
]
```

## How the model uses a skill

1. The model sees `- **smoke-test** — …` in the system prompt index.
2. When it needs to run smoke tests it calls:
   ```json
   { "tool": "load_skill", "input": { "name": "smoke-test" } }
   ```
3. Alfred returns the body of `SKILL.md`.
4. The model follows the steps in the body, reading `endpoints.json` and
   executing the bash commands.

## Tips

- **Keep descriptions short.** The description is injected into every system
  prompt; one clear sentence is better than a paragraph.
- **Be imperative and specific in the body.** The body is fetched only when
  needed, so you can be as detailed as necessary.
- **Put shared data in resources.** JSON configs, checklists, and templates
  belong in Level-3 files — not embedded in the body — so they can be updated
  independently.
- **Use deterministic steps.** Skills are procedural memory; they work best
  when the steps are concrete and unambiguous rather than open-ended
  suggestions.

::: tip Skill not appearing in the index?
Check that both `name` and `description` are non-empty in the frontmatter and
that the file is at `.alfred/skills/<name>/SKILL.md` (the subdirectory name
does not have to match the `name` frontmatter key, but it is good practice to
keep them aligned).
:::

::: warning No hot-reload
Skills are discovered once at agent startup. If you add or edit a skill during
a run, restart Alfred to pick up the change.
:::
