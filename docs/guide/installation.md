# Installation

Alfred runs on [Bun](https://bun.sh) ≥ 1.3.0 and requires only three runtime dependencies: `@anthropic-ai/sdk`, `commander`, and `zod`. No Node.js required.

---

## Prerequisites

| Requirement | Minimum version | Check |
|---|---|---|
| [Bun](https://bun.sh) | 1.3.0 | `bun --version` |
| An Anthropic API key (or an Anthropic-compatible key) | — | `echo $ANTHROPIC_API_KEY` |

Install Bun if you don't have it:

```bash
curl -fsSL https://bun.sh/install | bash
```

::: info OpenAI-compatible endpoints
If you prefer OpenAI or a compatible gateway (e.g. Zhipu GLM), see [Provider configuration](#provider-configuration) below — the Anthropic SDK backend speaks the Messages API, so any compatible endpoint works by pointing `ALFRED_BASE_URL` at it.
:::

---

## Install from npm

Alfred is published as [`alfred-agent`](https://www.npmjs.com/package/alfred-agent) (the bare name `alfred` is taken on npm); the installed command is still `alfred`:

```bash
bun install -g alfred-agent   # puts `alfred` on your PATH
# or run one-shot without installing:
bunx alfred-agent -p "explain what this repo does"
```

::: warning Bun only
The package ships TypeScript that uses Bun APIs directly — install and run it with Bun, not `npm`/`npx`/Node.
:::

---

## Clone and install (for development)

The npm package ships the runtime only. Clone the repo for the docs, tests, bench, and the zero-key demo:

```bash
git clone https://github.com/BeamusWayne/Alfred.git
cd Alfred
bun install
```

`bun install` reads `package.json` and installs the three runtime dependencies. There are no native binaries or build steps.

---

## The `alfred` binary

`package.json` declares:

```json
{
  "bin": { "alfred": "src/index.ts" }
}
```

Bun runs TypeScript directly from source — `src/index.ts` is the entry point without a compile step.

### Option A — `bun link` (recommended, gets a global `alfred` command)

```bash
bun link
alfred --version
```

`bun link` registers the package globally. After this, `alfred` is available in any directory.

### Option B — `bun run src/index.ts` (no global install)

If you prefer not to install globally, prefix every command with `bun run src/index.ts`:

```bash
bun run src/index.ts -p "explain what this repo does"
```

The docs always use `alfred …` for brevity; substitute `bun run src/index.ts` if you chose Option B.

---

## Setting your API key

Alfred defaults to the Anthropic provider. Export your key before any run that contacts the API:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

For OpenAI:

```bash
export ALFRED_PROVIDER=openai
export OPENAI_API_KEY="sk-..."
```

::: warning Key required at run time, not install time
Alfred validates the key at the first API call, not at startup. If the key is missing, Alfred prints a clear error to stderr and returns exit code 1. It never silently proceeds with a missing credential.
:::

---

## Provider configuration

| Environment variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Credential for the Anthropic provider (default). |
| `OPENAI_API_KEY` | Credential for the OpenAI provider. |
| `ALFRED_PROVIDER` | `anthropic` (default) or `openai`. |
| `ALFRED_BASE_URL` | Override the provider base URL — point at any Anthropic-compatible endpoint. |
| `ALFRED_MODEL` | Default model for all roles. |
| `ALFRED_MODEL_ARCHITECT` | Model for the architect role (planning). |
| `ALFRED_MODEL_EDITOR` | Model for the editor role (applying edits). |
| `ALFRED_MODEL_SUBAGENT` | Model for delegated subtasks. |

### Using Zhipu GLM or any Anthropic-compatible gateway

The Anthropic provider speaks the Messages API, so any compatible gateway works with no code change:

```bash
export ALFRED_BASE_URL="https://open.bigmodel.cn/api/anthropic"
export ANTHROPIC_API_KEY="<your-zhipu-key>"
alfred -p --model glm-5.1 "hello"
```

Pricing entries for `glm-4.5`, `glm-4.6`, and `glm-5.1` are included in Alfred's cost table; unknown models fall back to a default estimate.

---

## Opt-in layers (environment flags)

These features are off by default and are enabled by setting the corresponding variable before any `alfred` invocation:

| Variable | What it enables |
|---|---|
| `ALFRED_MEMORY=1` | Inject agent memory (Core: `USER.md` + `MEMORY.md`) into the system prompt and run staleness/contradiction GC on session end (`src/memory/localFile.ts`). |
| `ALFRED_REPOMAP=1` | Inject a repo map (PageRank-weighted symbol graph) into the system prompt (`src/context/repomap.ts`). |
| `ALFRED_SANDBOX=1` | Run `bash` inside an OS sandbox (macOS seatbelt; no-op on other platforms). |
| `ALFRED_OTEL_FILE=path.jsonl` | Export OTel GenAI semantic-convention spans to a file (`src/telemetry/otel.ts`). |
| `ALFRED_EGRESS_ALLOW=host1,*.host2` | `web_fetch` egress allow-list; comma-separated hostnames/globs (default-deny). |
| `ALFRED_LEDGER_SECRET` | HMAC secret for the autonomous run ledger. If unset, a dev-insecure default is used — **always set this in production autonomous runs**. |
| `ALFRED_VERIFY_CMD` | Default verify command for `alfred run` (overridden by `--verify`). Defaults to `bun test`. |

---

## Local state directory

Alfred creates `.alfred/` in the working directory (git-ignored by convention; add it to `.gitignore` yourself). All state is plain files:

```
.alfred/
  memory/
    USER.md           # stable prefs and conventions (core tier)
    MEMORY.md         # one-line index of every stored fact (core tier)
    facts/<slug>.md   # one fact per file, YAML frontmatter (recall tier)
    episodes/         # per-feature episodic records (JSON)
    archive/          # aged-out facts moved here by GC
    index.db          # SQLite FTS5 index over facts + transcripts
  skills/
    <name>/SKILL.md   # Level-1 skill index; body loaded on demand
  hooks.json          # PreToolUse / PostToolUse matchers
  workflows/<runId>/
    journal.jsonl     # append-only agent step tape (resume / replay)
    ledger.jsonl      # HMAC hash-chained Proof Receipt
```

Every file is readable with standard tools (`cat`, `jq`, `sqlite3`). Nothing is binary or proprietary.

---

## Verifying the installation

After `bun install`, run the full test suite and the TypeScript type check:

```bash
bun test        # 867 tests; all should pass
bun run typecheck  # tsc --noEmit; zero errors
```

A clean run looks like:

```
bun test v1.x.x
538 pass
0 fail
```

::: tip If tests fail
Check that you are on Bun ≥ 1.3.0 (`bun --version`) and that `bun install` completed without errors. No API key is needed to run the test suite — the tests use a `MockProvider` that never contacts an external endpoint.
:::
