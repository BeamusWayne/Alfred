# Alfred CLI

AI-powered CLI coding assistant, inspired by Claude Code. Built with TypeScript + Bun.

English | [中文](./README.zh-CN.md)

## Architecture

Alfred is structured as a modular agent loop: user message → LLM reasoning → tool execution → result feedback → continue or stop.

```
src/
├── index.ts            CLI entry point (Commander.js)
├── repl.ts             REPL launcher (Ink / React for CLI)
├── version.ts          Version constant
├── providers/          LLM backend abstraction
│   ├── anthropic.ts    Anthropic Claude provider
│   ├── openai.ts       OpenAI GPT provider
│   └── types.ts        Message, ContentBlock, StreamEvent types
├── tools/              Tool system
│   ├── types.ts        Tool interface, buildTool() factory
│   ├── bash.ts         Shell command execution
│   ├── fileRead.ts     File reading with line numbers
│   ├── fileWrite.ts    File writing
│   ├── fileEdit.ts     String replacement editing
│   ├── glob.ts         File pattern search
│   ├── grep.ts         Content search (rg/grep)
│   ├── webFetch.ts     URL content fetching
│   ├── webSearch.ts    Web search (placeholder)
│   ├── agent.ts        Sub-agent execution
│   ├── taskCreate.ts   Task creation
│   ├── taskUpdate.ts   Task status update
│   ├── taskList.ts     Task listing
│   ├── skillTool.ts    Skill execution
│   └── memoryTool.ts   Memory CRUD tools
├── permissions/        Permission pipeline
│   └── types.ts        evaluatePermission(), modes
├── query/              Agent loop engine
│   ├── engine.ts       AsyncGenerator-based query loop
│   └── types.ts        QueryEvent, QueryConfig
├── commands/           Slash command system
│   ├── types.ts        Command registry, parseCommand()
│   ├── help.ts         /help
│   ├── clear.ts        /clear
│   ├── model.ts        /model
│   ├── cost.ts         /cost
│   ├── config.ts       /config
│   ├── compact.ts      /compact
│   └── auth.ts         /login, /logout
├── context/            System prompt assembly
│   ├── git.ts          Git context (branch, status)
│   ├── claudemd.ts     CLAUDE.md discovery
│   └── index.ts        buildSystemPrompt()
├── mcp/                MCP protocol support
│   └── types.ts        connectMcpServer()
├── components/         Terminal UI
│   └── Repl.tsx        Ink React REPL component
├── skills/             Skill system
│   ├── store.ts        In-memory skill registry
│   └── loader.ts       Load .md skills from directory
├── plugins/            Plugin system
│   ├── store.ts        Plugin registry
│   └── loader.ts       Load from manifest.json
├── memory/             Persistent memory
│   ├── store.ts        File-backed memory store
│   └── search.ts       Text-based memory search
├── vim/                Vim modal editing
│   └── editor.ts       INSERT/NORMAL mode state machine
├── auth/               Authentication
│   └── manager.ts      API key storage (credentials.json)
├── cost/               Cost tracking
│   └── tracker.ts      Token counting + model pricing
├── config/             Configuration
│   └── manager.ts      Zod-validated settings
├── compact/            Auto context compression
│   └── engine.ts       Token estimation + message compaction
└── tasks/              Task tracking
    └── store.ts        In-memory task store
```

## Features (20/20 passing)

| # | Feature | Description |
|---|---------|-------------|
| F01 | Project Scaffold | Bun + TypeScript, CLI entry (Commander.js), build config |
| F02 | LLM Provider Layer | Provider interface (chat/stream/countTokens), Anthropic + OpenAI |
| F03 | Tool System Framework | buildTool() factory, Zod schema, tool registry |
| F04 | Core Tools | Bash, FileRead, FileWrite, FileEdit, Glob, Grep |
| F05 | Permission System | 4 modes (default/plan/auto/bypass), allow/deny/ask rules |
| F06 | Terminal UI | Ink (React for CLI), REPL, streaming output |
| F07 | Agent Loop | AsyncGenerator query engine, concurrent tool execution |
| F08 | Context System | CLAUDE.md discovery, git context, system prompt assembly |
| F09 | Slash Commands | /help, /clear, /model, /cost, /config, /compact |
| F10 | Advanced Tools | AgentTool, WebFetchTool, WebSearchTool |
| F11 | MCP Support | MCP client connection, tool bridge |
| F12 | Task Management | TaskCreate, TaskUpdate, TaskList tools |
| F13 | Skills System | Markdown skill files, frontmatter parsing, /skill-name commands |
| F14 | Plugin System | manifest.json loading, plugin commands |
| F15 | Memory System | File-backed memory, text search, context fencing |
| F16 | Vim Mode | INSERT/NORMAL modes, hjkl, x, dd, 0/$ |
| F17 | Auth System | API key storage, /login /logout commands |
| F18 | Cost Tracking | Token counting, model pricing (Opus/Sonnet/Haiku) |
| F19 | Configuration | Zod-validated settings, load/save/get/set |
| F20 | Auto Compact | Token estimation, threshold detection, message compaction |

## Quick Start

```bash
# Install dependencies
bun install

# Run CLI
bun run src/index.ts

# Run with a prompt
bun run src/index.ts "list files in current directory"

# Run tests
bun test

# Verify CLI works
bun run check
```

## CLI Options

```
alfred [options] [prompt]

Options:
  -V, --version                 Print version
  -m, --model <model>           Model to use
  -p, --print                   Non-interactive mode
  --allowedTools <tools...>     Auto-allow specific tools
  --disallowedTools <tools...>  Deny specific tools
  --verbose                     Enable verbose logging
  -h, --help                    Show help
```

## Key Design Patterns

### Tool Factory

Every tool is created via `buildTool()` with safe defaults:

```typescript
export const myTool = buildTool({
  name: "my_tool",
  description: "Does something useful",
  inputSchema: z.object({ query: z.string() }),
  isReadOnly: () => true,
  call: async (input, context) => {
    return { content: "result" };
  },
});
```

### Provider Abstraction

Switch LLM backends without changing tool code:

```typescript
import { getProvider } from "./providers/index.js";

const provider = getProvider("anthropic"); // or "openai"
const response = await provider.chat(messages, { tools });
```

### Agent Loop

The query engine is an AsyncGenerator yielding events:

```typescript
for await (const event of query(config)) {
  if (event.type === "text") process.stdout.write(event.content);
  if (event.type === "tool_use") executeTool(event);
}
```

### Concurrent Tool Execution

Read-only + concurrency-safe tools run in parallel; write tools run serially:

```
Tool partition → [ReadTool, GlobTool, GrepTool]  // parallel
               → [WriteTool, EditTool, BashTool]  // serial
```

## Testing

182 tests across 20 files, 316 assertions:

```bash
bun test          # Run all tests
bun test tests/tools.test.ts  # Run specific file
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `@anthropic-ai/sdk` | Anthropic Claude API |
| `openai` | OpenAI GPT API |
| `@commander-js/extra-typings` | CLI argument parsing |
| `ink` + `react` | Terminal UI framework |
| `zod` | Schema validation |
| `chalk` | Terminal colors |
| `@modelcontextprotocol/sdk` | MCP protocol client |

## License

MIT
