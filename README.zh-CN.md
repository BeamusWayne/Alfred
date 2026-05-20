# Alfred CLI

AI 驱动的 CLI 编程助手，灵感来自 Claude Code。使用 TypeScript + Bun 构建。

[English](./README.md) | 中文

## 架构

Alfred 的核心是一个模块化的 Agent 循环：用户消息 → LLM 推理 → 工具执行 → 结果反馈 → 继续或终止。

```
src/
├── index.ts            CLI 入口 (Commander.js)
├── repl.ts             REPL 启动器 (Ink / React 终端 UI)
├── version.ts          版本号
├── providers/          LLM 后端抽象层
│   ├── anthropic.ts    Anthropic Claude 提供者
│   ├── openai.ts       OpenAI GPT 提供者
│   └── types.ts        Message、ContentBlock、StreamEvent 类型
├── tools/              工具系统
│   ├── types.ts        Tool 接口、buildTool() 工厂函数
│   ├── bash.ts         Shell 命令执行
│   ├── fileRead.ts     带行号的文件读取
│   ├── fileWrite.ts    文件写入
│   ├── fileEdit.ts     字符串替换编辑
│   ├── glob.ts         文件模式搜索
│   ├── grep.ts         内容搜索 (rg/grep)
│   ├── webFetch.ts     URL 内容抓取
│   ├── webSearch.ts    Web 搜索（占位）
│   ├── agent.ts        子 Agent 执行
│   ├── taskCreate.ts   任务创建
│   ├── taskUpdate.ts   任务状态更新
│   ├── taskList.ts     任务列表
│   ├── skillTool.ts    技能执行
│   └── memoryTool.ts   记忆增删查工具
├── permissions/        权限管道
│   └── types.ts        evaluatePermission()、权限模式
├── query/              Agent 循环引擎
│   ├── engine.ts       基于 AsyncGenerator 的查询循环
│   └── types.ts        QueryEvent、QueryConfig
├── commands/           斜杠命令系统
│   ├── types.ts        命令注册表、parseCommand()
│   ├── help.ts         /help
│   ├── clear.ts        /clear
│   ├── model.ts        /model
│   ├── cost.ts         /cost
│   ├── config.ts       /config
│   ├── compact.ts      /compact
│   └── auth.ts         /login、/logout
├── context/            系统提示词组装
│   ├── git.ts          Git 上下文（分支、状态）
│   ├── claudemd.ts     CLAUDE.md 文件发现
│   └── index.ts        buildSystemPrompt()
├── mcp/                MCP 协议支持
│   └── types.ts        connectMcpServer()
├── components/         终端 UI 组件
│   └── Repl.tsx        Ink React REPL 组件
├── skills/             技能系统
│   ├── store.ts        内存技能注册表
│   └── loader.ts       从目录加载 .md 技能文件
├── plugins/            插件系统
│   ├── store.ts        插件注册表
│   └── loader.ts       从 manifest.json 加载插件
├── memory/             持久化记忆
│   ├── store.ts        基于文件的记忆存储
│   └── search.ts       文本搜索记忆
├── vim/                Vim 模式编辑
│   └── editor.ts       INSERT/NORMAL 模式状态机
├── auth/               认证系统
│   └── manager.ts      API 密钥存储 (credentials.json)
├── cost/               成本追踪
│   └── tracker.ts      Token 计数 + 模型定价
├── config/             配置管理
│   └── manager.ts      Zod 校验的设置文件
├── compact/            自动上下文压缩
│   └── engine.ts       Token 估算 + 消息压缩
└── tasks/              任务追踪
    └── store.ts        内存任务存储
```

## 功能清单（20/20 通过）

| # | 功能 | 说明 |
|---|------|------|
| F01 | 项目脚手架 | Bun + TypeScript、CLI 入口 (Commander.js)、构建配置 |
| F02 | LLM Provider 抽象层 | Provider 接口 (chat/stream/countTokens)，支持 Anthropic + OpenAI |
| F03 | 工具系统框架 | buildTool() 工厂函数、Zod schema 验证、工具注册表 |
| F04 | 核心工具 | Bash、FileRead、FileWrite、FileEdit、Glob、Grep |
| F05 | 权限系统 | 4 种模式 (default/plan/auto/bypass)，allow/deny/ask 规则 |
| F06 | 终端 UI | Ink (React for CLI)、REPL、流式输出 |
| F07 | Agent 循环 | AsyncGenerator 查询引擎，并发工具执行 |
| F08 | 上下文系统 | CLAUDE.md 发现、Git 上下文、系统提示词组装 |
| F09 | 斜杠命令 | /help、/clear、/model、/cost、/config、/compact |
| F10 | 高级工具 | AgentTool、WebFetchTool、WebSearchTool |
| F11 | MCP 协议支持 | MCP 客户端连接、工具桥接 |
| F12 | 任务管理工具 | TaskCreate、TaskUpdate、TaskList |
| F13 | 技能系统 | Markdown 技能文件、frontmatter 解析、/skill-name 命令 |
| F14 | 插件系统 | manifest.json 加载、插件命令注册 |
| F15 | 持久化记忆系统 | 基于文件的存储、文本搜索、上下文围栏 |
| F16 | Vim 模式 | INSERT/NORMAL 模式、hjkl 移动、x 删除、dd 删除行、0/$ 行首行尾 |
| F17 | 认证系统 | API 密钥管理、/login /logout 命令 |
| F18 | 成本追踪 | Token 计数、模型定价 (Opus/Sonnet/Haiku) |
| F19 | 配置管理 | Zod 校验的设置文件、load/save/get/set |
| F20 | 自动上下文压缩 | Token 估算、阈值检测、消息压缩 |

## 快速开始

```bash
# 安装依赖
bun install

# 运行 CLI
bun run src/index.ts

# 带初始提示运行
bun run src/index.ts "列出当前目录的文件"

# 运行测试
bun test

# 验证 CLI 正常
bun run check
```

## CLI 参数

```
alfred [options] [prompt]

参数:
  prompt                        发送给助手的初始提示

选项:
  -V, --version                 输出版本号
  -m, --model <model>           使用的模型
  -p, --print                   非交互模式（仅输出）
  --allowedTools <tools...>     自动允许的工具列表
  --disallowedTools <tools...>  禁止使用的工具列表
  --verbose                     启用详细日志
  -h, --help                    显示帮助
```

## 核心设计模式

### 工具工厂

所有工具通过 `buildTool()` 创建，自带安全默认值：

```typescript
export const myTool = buildTool({
  name: "my_tool",
  description: "做一些有用的事",
  inputSchema: z.object({ query: z.string() }),
  isReadOnly: () => true,
  call: async (input, context) => {
    return { content: "结果" };
  },
});
```

### Provider 抽象

切换 LLM 后端无需修改工具代码：

```typescript
import { getProvider } from "./providers/index.js";

const provider = getProvider("anthropic"); // 或 "openai"
const response = await provider.chat(messages, { tools });
```

### Agent 循环

查询引擎是 AsyncGenerator，持续产出事件：

```typescript
for await (const event of query(config)) {
  if (event.type === "text") process.stdout.write(event.content);
  if (event.type === "tool_use") executeTool(event);
}
```

### 并发工具执行

只读 + 并发安全的工具并行执行，写入工具串行执行：

```
工具分区 → [ReadTool, GlobTool, GrepTool]   // 并行
        → [WriteTool, EditTool, BashTool]   // 串行
```

## 测试

20 个测试文件，182 个测试用例，316 个断言，全部通过：

```bash
bun test                          # 运行全部测试
bun test tests/tools.test.ts     # 运行指定文件
```

## 端到端验证

```bash
# 测试套件
bun test
# → 182 pass, 0 fail

# CLI 入口
bun run src/index.ts --help
# → 输出帮助信息

# 版本号
bun run src/index.ts --version
# → 0.1.0

# 模块导入验证（全部正常）
# providers / vim / cost / compact / memory / skills / plugins
```

## 依赖

| 包名 | 用途 |
|------|------|
| `@anthropic-ai/sdk` | Anthropic Claude API |
| `openai` | OpenAI GPT API |
| `@commander-js/extra-typings` | CLI 参数解析 |
| `ink` + `react` | 终端 UI 框架 |
| `zod` | Schema 校验 |
| `chalk` | 终端颜色 |
| `@modelcontextprotocol/sdk` | MCP 协议客户端 |

## 致谢

本项目灵感来自 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)，参考了其架构设计。

## 许可证

MIT
