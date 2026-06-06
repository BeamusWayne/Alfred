# Alfred 改进方案书 — 取百家之长的目标架构

[English](./improvement-proposal.md) | **中文**

> **摘要**:本方案书在前一份《Alfred vs. the Field》代码级评审的基础上,提出 Alfred 的**目标架构**——不是再克隆一个 Claude Code,而是「取百家之长」融合成一个 *可验证的自治 coding agent*。两个重点引入:(A) **记忆系统**——融合 Hermes Agent(Nous Research)的五支柱/四阶段流/可插拔 provider、MemGPT/Letta 的 OS 三层模型、Anthropic 的 memory tool + context editing,以及本仓库 `CLAUDE.md` 记忆体系的 file-first 自策展范式;(B) **dynamic workflow**——把 Claude Code 的动态工作流(确定性多 agent 编排)引入 Alfred,并与自治 harness 融合,使「自治即代码、每次运行可重放可审计」。此外 §6 再补四个交叉领域(代码智能、Agent 安全、可观测、模型路由)。每一项都给出**采纳 / 改造 / 不采纳**的综合评估和落到 `src/` 的文件映射。本文档供决策是否纳入 `docs/`。
>
> **状态:** Proposal / RFC · **日期:** 2026-06-05 · **依据:** `BeamusWayne/Alfred` 代码级评审 + 联网研究(Hermes Agent、MemGPT/Letta、Claude memory tool、Mem0/Zep、Claude Code dynamic workflow、lethal-trifecta 安全、OTel GenAI、Aider repo-map/architect-editor、LSP)。· **配套文档:** `alfred-vs-the-field.md`(本文所基于的差距分析)。

---

## 0. 如何阅读本文档

配套评审(`alfred-vs-the-field.md`)回答的是:*「Alfred 落后在哪、哪些是必修项?」*——7 维、54 条建议、P0/P1/P2。

本方案书回答**另一个**问题:*「如果让我们从每个领先系统各取一个最好的点来重设计 Alfred 的脊柱,目标架构该是什么——又该明确拒绝什么?」* 它前瞻、有主见,**不**重复 gap 列表,假定 P0 已修好并在其上构建。

两个子系统重点深挖(你点名,且是最高杠杆的*架构*级而非补 bug 级动作):**§4 记忆** 与 **§5 动态工作流**。**§6** 再补四个交叉领域(代码智能、Agent 安全、可观测、模型路由)。**§7** 压缩其余脊柱。**§8** 是**综合评估**表。**§9** 是分阶段。

---

## 1. 愿景与非目标

**愿景(承评审、并收紧)**:Alfred 是**可验证的自治 coding agent**——唯一一个让长时 harness *可执行*、把「完成」做成*机器强制闸*、记忆*agent 自策展但可检视*、每次 hands-off 运行都留下*签名、可重放收据*的 CLI。它是「可证明的 agent 可靠性」组合里的 coding-agent 支柱,与 `trace-vault`(record/replay)、`provenant`(HMAC Proof Receipt)并列。

**非目标(明确不追)**:

- ❌ 把 token streaming / TUI 美化的*对标*当目的——必要(P1),但不差异化。
- ❌ 云控制面、托管记忆、任何多租户——Alfred 设计上本地优先、可检视。
- ❌ 通用多 agent「操作系统」。只在让自治可审计的地方采纳编排。
- ❌ 复刻 Hermes 的每根支柱(crons、soul)——取 memory + skills + 自改进循环,把 crons 映射到 harness 调度,soul 映射成一个可选的薄 tone 文件。

**全程要把握的一个张力**:*agent 自策展*(模型决定记什么/怎么编排)对 *可验证*(人或确定性检查能审计)。每个借来的点都往第二极弯——这正是 Alfred 存在的全部理由。

---

## 2. 设计原则(取百家之长的取舍尺)

两个来源冲突时,Alfred 选更满足这些的那个。它们是「借什么」的判据。

| # | 原则 | 后果 |
|---|---|---|
| P1 | **File-first 且可检视** | 记忆、skills、账本、checkpoint 都是 `.alfred/` 里能 `cat`、`git diff`、手改的纯文件。(Hermes 的 `MEMORY.md`/`USER.md`;你的 CLAUDE.md 体系;Aider repo-map。) |
| P2 | **provider 抽象** | 凡有多个可信后端的(LLM、记忆、沙箱)都放到小接口后,配一个零依赖本地默认。(对应 Alfred 既有 `src/providers/` + `buildTool()` 基因;Hermes 记忆 provider 契约。) |
| P3 | **关键处确定性** | 控制流(编排、harness 循环、停止条件、闸)是*代码*,不由模型决定。模型填格子,格子手工接线。(Claude Code dynamic workflow;`trace-vault`;本仓库 `CLAUDE.md` Rule 5。) |
| P4 | **agent 提议、机器验证** | LLM 提议(记什么、某 feature 是否完成);确定性检查裁决(退出码、schema 校验、矛盾扫描、HMAC)。 |
| P5 | **渐进披露** | 大知识(skills、记忆、工具目录、repo map)便宜索引、按需加载,绝不一股脑塞。(Hermes/Claude skills;MemGPT 分页;Aider PageRank。) |
| P6 | **默认安全、显式升级** | OS 沙箱 + 先问;不可信内容隔离;权力藏在吓人 flag 后。(Codex/Claude Code 沙箱;lethal-trifecta 防御。) |
| P7 | **每次运行留收据** | 记忆写入、工具调用、verify 退出码、git SHA → 一份只追加、可签名、同时兼作 OTel trace 的账本。(`provenant`/`trace-vault`。) |

---

## 3. 目标架构一览

```
                 ┌──────────────────────────────────────────────┐
   alfred run /  │              ORCHESTRATION (§5)              │   ← 新:dynamic workflows
   alfred exec / │   workflow runtime: agent()/pipeline()/       │      (Claude Code 模型)
   alfred wf …   │   parallel()  · structured I/O (Zod) ·        │
                 │   journal+resume · token budget               │
                 └───────────────┬──────────────────────────────┘
                                 │ 驱动
        ┌────────────────────────▼───────────────────────────────┐
        │                  AUTONOMY HARNESS (§7.7)                 │   ← 内置 workflow:
        │  feature_list 状态机 · verify-fix 循环 ·                 │      verify-fix、best-of-N、
        │  rubric 闸 · checkpoint/回滚 · HMAC 运行账本             │      自评
        └───┬───────────────┬───────────────┬─────────────────────┘
            │ 用            │ 用            │ 用
   ┌────────▼──────┐ ┌──────▼───────┐ ┌─────▼────────────────────┐
   │  AGENT LOOP   │ │   MEMORY (§4)│ │  TOOLS · PERMISSIONS ·    │
   │ query/engine  │ │ 分层 ·        │ │  SANDBOX · CONTEXT/CACHE  │
   │ retry·stream· │ │ file-first ·  │ │  (§7: 模糊编辑、路径牢、   │
   │ 类型化状态     │ │ provider ·    │ │   seatbelt、hooks、MCP、  │
   │               │ │ 四阶段流      │ │   prompt-cache)           │
   └───────┬───────┘ └──────┬───────┘ └─────┬────────────────────┘
           └────────────────┴───────── PROVIDERS (Anthropic/OpenAI) ┘
                         一切都发往 → .alfred/ledger(签名)
```

新部件(**编排**、**记忆 v2**、**harness**)是*覆盖在 Alfred 既有模块上的层*,不是重写。§6 的四个领域是**交叉的**——穿过上面每个格子:**代码智能**(更好的编辑)、**Agent 安全**(每个工具的污点/egress)、**可观测**(每个格子一个 span)、**模型路由**(每个格子配对的模型)。既有 `src/query/engine.ts`、`src/memory/*`、`src/context/*`、`src/tools/agent.ts`、`src/tasks/*` 是挂载点。

---

## 4. 重点引入 A —— 记忆系统(取百家之长)

### 4.1 各家最值得偷的那一点

| 系统 | 值得偷的一个点 | 来源 |
|---|---|---|
| **Hermes Agent**(Nous) | **agent 自策展的 `USER.md` + `MEMORY.md`** + **四阶段流**(inject→prefetch→sync→extract) + **可插拔 provider 契约** + 把「**stale memory 是头号怪异行为来源**」当一等 GC 关切。 | [[H1]](#h1)[[H2]](#h2) |
| **MemGPT / Letta** | **OS 分层**:core(常驻 RAM)/ recall(可搜)/ archival(冷盘),agent 自行换页;**情景连贯**(「昨天试了 X 失败了」)。 | [[M1]](#m1) |
| **Anthropic memory tool + context editing** | 记忆 = **模型 CRUD 的客户端文件目录**;**context editing** 在接近上限时自动清除陈旧*工具结果*(100 轮 eval 省 84% token)。 | [[A1]](#a1)[[A2]](#a2) |
| **Holographic / Hindsight(Hermes provider)** | 本地 **`fact_store`**,带 `add/search/probe/related/**reason**/**contradict**/update/remove/list` + `fact_feedback`;**`reflect`** 反思。矛盾与反思是显式操作。 | [[H1]](#h1) |
| **Mem0 / Zep** | Mem0:极简向量召回(默认体验好)。Zep:**时序**知识图(事实带有效期)。 | [[F1]](#f1) |
| **你的 CLAUDE.md 记忆体系** | **每事实一文件** + 带类型 frontmatter(`user/feedback/project/reference`)+ 每会话加载的 **`MEMORY.md` 索引** + 「**更新而非重复;错的删掉**」。 | (本仓库) |

**关键认识**:Hermes 的 `USER.md`+`MEMORY.md`+自策展+陈旧 GC,和你每天在用的 CLAUDE.md 体系*是同一族*。两套独立的生产系统收敛到 **file-first、agent 自策展、带索引** 的记忆。这种收敛就是信号——Alfred 应把它当**核心**,把向量/图库(Mem0/Zep)当*可选 provider*,而非地基。

### 4.2 提议架构 ——「Alfred Memory v2」

**一句话:** *分层、file-first、agent 自策展、provider 抽象、可验证。*

**磁盘布局(P1 file-first):**

```
.alfred/memory/
  USER.md                 # core:稳定偏好/惯例(Hermes user.md ＋ 你的 `type:user`)
  MEMORY.md               # core:每条事实一行的索引(你的索引 ＋ Hermes memory.md)
  facts/<slug>.md         # recall:每事实一文件,frontmatter {type, scope, ts, ttl?}
  episodes/<id>.json      # 情景:每任务一记录 {goal, approach, worked, failed, verifyExit, gitSha}
  archive/…               # archival:摘要化/老化的事实与情景
  index.db                # recall:对 facts + 会话转录的 SQLite FTS5(Holographic 式)
```

**分层(MemGPT/Hermes OS 模型,P5 渐进披露):**

- **Core** —— `USER.md` + `MEMORY.md` 索引 + 当前 feature/进度指针。*始终*注入系统提示,硬 token 预算(如 ≤1.5k;索引超了就把最旧的摘要进 `archive/`)。这是「RAM」。
- **Recall** —— `facts/*.md` 与会话转录,由 `memory` 工具(search/get)与 **prefetch** 按需取。「可搜的盘」。
- **Archival** —— 老化/再摘要的冷存,可取但不自动加载。

**四阶段流(Hermes),接进 loop:**

1. **Inject** —— `src/context/index.ts` 把 Core 放进系统提示(依赖 P0「接好系统提示」)。把易变的日期放**最后**,让稳定的记忆前缀对缓存友好(缓存的 P1,§7)。
2. **Prefetch** —— `src/query/engine.ts` 每轮前,对最新 user/目标文本做*非阻塞*召回,把 top-k 事实作为临时上下文追加(下一轮被 context-editing 清除)。
3. **Sync** —— 每轮后,候选事实入队(不同步写——`writeFrequency` 可配:`turn|session|N`,沿 Hermes/Honcho)。
4. **Extract** —— 会话/feature 结束时,agent 策展:去重、矛盾扫描、写持久事实 + 一条**情景记录**。

**策展 = agent 提议、机器验证(P4):**

- *agent 提议*:经记忆工具(Claude memory-tool 的 CRUD 面——Alfred 已有 `src/tools/memoryTool.ts`):`memory.upsert`、`memory.search`、`memory.get`、`memory.forget`、`memory.contradict`。
- *机器验证*:extract 时跑一遍确定性的**矛盾/陈旧扫描**(Holographic `contradict` + Hermes 陈旧警告)——标记 `ttl` 过期、`scope`(如某文件路径)已不存在、或与更新事实相矛盾的事实。这把 Hermes 的「stale memory 是头号问题」从建议变成确定性检查。
- **情景是通往自治的桥**:每个 feature 后,`episodes/<id>.json` 记 `{goal, approach, worked, failed, verifyExit, gitSha, cost}`。这是 (a) Letta 式情景连贯、(b) 自改进循环的输入、(c) 经签名后是**运行账本**(P7)里的一行。「上次试了什么、测试过没」变成真实查询。

**provider 抽象(Hermes 契约 + Alfred 基因,P2):**

```ts
// src/memory/provider.ts
interface MemoryProvider {
  inject(ctx): Promise<MemoryBlock>          // Core → 系统提示
  prefetch(query, k): Promise<Fact[]>        // Recall,非阻塞
  sync(turn): Promise<void>                   // 候选入队
  extract(session): Promise<void>             // 结束时策展
  search(q): Promise<Fact[]>; upsert(f); get(id); forget(id); contradict(f)
}
```

- **默认 provider:`LocalFileProvider`** —— 上面的 `.alfred/memory/` 布局 + SQLite FTS5。零网络、git 友好、可检视。只*建*这一个。
- **可选 adapter(以后,社区级):** `Mem0Provider`、`ZepProvider` —— 同契约,给想要托管向量/时序图召回的用户。我们*设计缝*,不内置后端。

**文件映射:**

| 新/改 | 角色 |
|---|---|
| `src/memory/provider.ts`(新) | 上面的接口 |
| `src/memory/providers/localFile.ts`(新) | 默认;替换今天扁平的 `src/memory/store.ts` + `search.ts` |
| `src/memory/episodes.ts`(新) | 情景写/查 |
| `src/tools/memoryTool.ts`(已有) | 变成 CRUD 面(upsert/search/get/forget/contradict) |
| `src/context/index.ts`(已有) | Core 注入(P0 接线后) |
| `src/query/engine.ts`(已有) | prefetch(轮前)+ sync(轮后)+ extract(结束)钩子 |
| `src/compact/engine.ts`(已有) | context-editing:清除陈旧*工具结果*,而非记忆 |

### 4.3 综合评估 —— 记忆部分采纳/改造/拒绝

| 想法 | 结论 | 为什么 |
|---|---|---|
| Hermes `USER.md`+`MEMORY.md`,agent 自策展,file-first | **采纳** | 与你的 CLAUDE.md 体系收敛;可检视;git 友好。核心。 |
| Hermes 四阶段流(inject/prefetch/sync/extract) | **采纳** | 生命周期干净;干净地映射到 loop。 |
| Hermes 可插拔 provider 契约 | **采纳(接口)/ 改造(后端)** | 只建本地 provider;给 Mem0/Zep 设计缝。 |
| MemGPT core/recall/archival 分层 | **改造** | 取分层 + token 预算化 core;*别*模拟整个 OS 或自改提示的复杂度。 |
| 情景任务记录 | **采纳 + 扩展** | 通往自改进*与*签名账本的桥——Alfred 的差异化。 |
| Holographic `contradict`/`reason`、Hindsight `reflect` | **采纳(contradict/陈旧)/ 推迟(reason/reflect)** | 矛盾+陈旧 GC 高价值且便宜;LLM「反思」属锦上添花。 |
| Anthropic context editing(清陈旧工具结果) | **采纳** | 与记忆正交;补充压缩;实测省 84% token。 |
| Mem0(向量)做默认 | **作为默认拒绝 / 作为 provider 改造** | 单用户规模下相对 FTS5 边际收益小却多依赖/索引;作 adapter 提供。 |
| Zep 时序知识图 | **作为核心拒绝 / 作为 provider 改造** | 强大但重、偏云;CLI 过度;仅未来 adapter。 |
| Hermes `soul.md`(人格) | **改造(可选)** | 一个薄的可选 tone 文件很便宜;非 coding agent 核心。 |
| Hermes crons | **映射,不移植** | coding-agent 的对应物是 harness 调度 / `alfred run`,不是个人助理 cron。 |

---

## 5. 重点引入 B —— 动态工作流(Claude Code 模型 → Alfred)

### 5.1 「dynamic workflow」到底是什么,为什么该引入

Claude Code 的 **dynamic workflow** 是*确定性多 agent 编排即代码*:一个带普通控制流(循环、条件、fan-out)的脚本,经几个注入的 helper —— `agent(prompt, {schema})`、`pipeline(items, …stages)`、`parallel(thunks)`、`log()` —— 派生子 agent,其中:

- **控制流是代码(P3 确定性)** —— *结构*(谁 fan out、谁验证、谁综合)手工编写;只有每个格子的*内容*由模型生成;
- **子 agent I/O 结构化** —— `schema` 强制每个 agent 吐出校验过的对象(无脆弱解析);
- **运行被 journal、可 resume** —— 完成的步骤在 resume 时返回缓存结果;运行可重放;
- **有 token 预算** —— 编排按目标伸缩。

这正是 Alfred 自治主张缺的连接组织。今天 Alfred 的 `src/tools/agent.ts` 是*桩*,「自治」是散文。一个 dynamic-workflow 运行时把「派生子 agent」(模型决定、不可审计)变成「**运行这个编排**(手工接线、journal、签名)」。

> **这是把 Alfred 整个故事缝起来的那一个点:** 自治 harness *本身就是*一个内置 workflow;用户任务(review、migrate、research)是*手写*的 workflow;因为 workflow 确定 + journal + 签名,「自治可执行可审计」从口号变成 runtime。

### 5.2 提议架构 ——「Alfred Orchestrator v1」

**建在已有之上。** 每个 `agent()` 是一次 `query()`(现有引擎),跑在*隔离*的消息列表上、强制结构化输出。Alfred 已用 **Zod** 做工具 schema —— 复用它做 `StructuredOutput`。

```
src/orchestrator/
  runtime.ts     # 给 workflow fn 注入 agent()/pipeline()/parallel()/log()
  agent.ts       # agent(prompt,{schema,label}) → 带隔离消息+强制 Zod 输出的 query()
  journal.ts     # 只追加 .alfred/workflows/<run>/journal.jsonl → resume + replay
  budget.ts      # token 预算(复用 src/cost/tracker.ts)
  workflows/
    autonomousRun.ts   # harness,作为 workflow(见 §5.3)
    review.ts          # 内置:维度 → 发现 → 对抗式验证
    bestOfN.ts         # 内置:N 条轨迹 → 按 VERIFY_CMD exit 0 选优
```

- **并发**对单用户 CLI 压低(如 4)—— P6/务实,不是 Claude Code 的 16。
- **把 `src/tools/agent.ts` 升格** 从桩变成 `orchestrator/agent.ts` 的薄封装,让*模型*也能派生(深度受限、Codex `max_depth=1` 式)子 agent,而 *workflow* 拿到完整运行时。
- **journal = resume + replay(P3/P7):** `journal.jsonl` 既是 Claude Code 的 resume 机制*又是* `trace-vault` 的重放磁带——同一份产物,两份收益。

### 5.3 融合:harness 即 workflow

这是 §5 与 §7.7(自治)合一之处。`alfred run` 执行 `workflows/autonomousRun.ts`:

```js
// 伪码 —— 确定性控制流,模型填格子
for (const feature of pickByPriority(featureList)) {           // feature_list.json 状态机
  let attempt = 0
  while (attempt++ < feature.iteration_budget) {               // verify-fix 内层循环(Aider/Devin)
    await agent(implementPrompt(feature), { tools: REAL_TOOLS })
    const verify = await bash(VERIFY_CMD)                       // init.sh → `bun test`,客观闸
    if (verify.exitCode === 0) break
    feedback = verify.stderr                                    // 失败 → 下一轮输入
  }
  const eval = await agent(rubricPrompt(feature, verify), { schema: RUBRIC })  // 自评闸
  if (eval.verification === 2 && verify.exitCode === 0) markPassing(feature, sign(episode))
  else if (consecutiveBlocked++ >= 2) break                    // 停止条件
}
```

- **best-of-N** = 把内层 attempt 包进 `parallel()`、跨 Alfred 两个 provider,选 `VERIFY_CMD` exit 0 的轨迹(OpenHands 式推理期扩展,但用*客观*奖励——不需训练 critic)。
- 每步追加到**签名账本**(P7):`{feature, toolHashes, verifyExit, rubric, cost, gitSha}`。该账本就是一次自治运行的 `provenant` 式 Proof Receipt。

### 5.4 综合评估 —— 工作流

| 想法(Claude Code dynamic workflow) | 结论 | 为什么 |
|---|---|---|
| `agent()/pipeline()/parallel()` 确定性运行时 | **采纳** | 可审计自治的连接组织;在现有引擎上小幅构建。 |
| 结构化输出 schema | **采纳** | Alfred 已有 Zod;近乎免费。 |
| journal → resume + replay | **采纳** | 兼作 `trace-vault` 重放磁带;启用 `--resume`。 |
| token 预算伸缩 | **采纳(简版)** | 复用 `CostTracker`;并发压低。 |
| harness 即 workflow | **采纳——旗舰** | 缝合整个叙事;让头号主张真正能跑。 |
| 跨 provider best-of-N、客观奖励 | **采纳(P2)** | 便宜、诚实的奖励(退出码)优于 LLM 裁判。 |
| 完整通用 workflow DSL / 市场 | **推迟** | 先出 2-3 个内置 workflow;之后再开放编写。 |
| 16 路并发、worktree 隔离 | **下调改造** | 单用户 CLI:低并发;用 git-stash checkpoint 替 worktree。 |

---

## 6. 再补四个交叉领域(代码智能 · Agent 安全 · 可观测 · 模型路由)

除记忆(§4)与工作流(§5),还有四个领域值得取百家之长——每个都填补一个*真实*的 Alfred 空白,且每个都强化「可验证 / 可靠 / 可审计」主线,而非追表面对标。它们是**交叉的**(穿过 §3 的每一层)。

### 6.1 代码智能与仓库理解

**最佳实践。** 两个互补层。(1) **repo map** 给全仓结构感知又不一股脑塞文件——Aider 用 **tree-sitter** 解析每个文件,跑 `.scm` 标签查询抽 `def`/`ref` 标签,建**有向图**(文件=节点,边=「A 引用了 B 中定义的符号」),再 **PageRank** 进固定 **token 预算**,按启发式给边加权(用户消息里出现的标识 10×、来自已在对话中文件的引用 50×、私有/泛滥名 0.1×)[[CI1]](#ci1)。(2) **按需的语义精度**经 **LSP**——跳定义、找引用、hover 类型、调用层级、**编辑后诊断**;查全部调用点 ~50ms vs 递归 grep 几十秒 [[CI2]](#ci2)。tree-sitter 只解析语法但快、容错;每次编辑后做一次 tree-sitter **解析检查**能在测试前抓出语法损坏,而 agent 原生封装(Kiro、LSAP 协议)把裸 LSP 变成高层工具 [[CI3]](#ci3)。值得注意:**Hermes Agent 正在两者都加**(repo-map #535、LSP 编辑后诊断 #516)——又一次收敛 [[CI4]](#ci4)。

**Alfred 的缺口。** Alfred **只有 `glob` + `grep`**(`src/tools/glob.ts`、`src/tools/grep.ts`)——纯文本搜索,零结构/语义理解。答不出「符号在哪定义/被谁用」,看不到类型,`fileEdit` 可写出**语法损坏**代码、只能等 `bun test`(若有覆盖)才抓到。大仓库里模型盲 grep、烧 turn。

**建议。** (a) **repo map** —— 新 `src/context/repomap.ts`(tree-sitter via `web-tree-sitter` + PageRank 进 token 预算),注入到记忆 Core 旁(§4)。(b) **编辑后 tree-sitter 语法检查** 在 `src/tools/fileEdit.ts`——结果不解析就拒绝(便宜;在 verify 循环前消灭一整类失败)。(c) **LSP 客户端** —— 新 `src/tools/lsp/`,把 `definition`/`references`/`hover`/`diagnostics` 暴露为工具 + 诊断信号进 harness verify 循环。**结论:采纳 repo-map(P1, M)+ 编辑后解析检查(P0-邻近, S);LSP 客户端(P2, M→L)。** 差异化:**正确性**——大幅减少幻觉编辑。

### 6.2 Agent 层安全:注入与外泄防御

**最佳实践。** 与 OS 沙箱不同(§7.3 约束*进程能做什么*);本节约束*不可信内容能让 agent 做什么*。威胁是 Simon Willison 的 **lethal trifecta**——**私有数据 + 不可信内容 + 外泄通道**同处一个上下文;任意两个安全,三个齐了可被利用 [[S1]](#s1)。因为 LLM **无法可靠区分可信指令与注入指令**,防御是架构性的:**dual-LLM**(有工具的特权 P-LLM 编排一个读不可信内容但*无工具*的隔离 Q-LLM);**CaMeL**(Google DeepMind——特权模型发出受限 Python 计划,**模型外的确定性策略引擎**决定执行什么,追踪污点/能力);以及**爆炸半径削减**——egress 白名单、密钥脱敏、把*每一个* web/MCP/bash 输出当不可信 [[S2]](#s2)[[S3]](#s3)。要命的事实:**没有任何主流 harness——Claude Code、Cursor、Hermes、Copilot、Gemini CLI——已落地这些** [[S2]](#s2)。

**Alfred 的缺口。** Alfred **三件套全开**:读私有仓库数据;摄入**不可信内容**(`src/tools/webFetch.ts` 抓任意 URL;MCP 桥把任意服务器输出直灌上下文);有**外泄通道**(无 egress 的 `bash`/`webFetch`)。`mode:"bypass"` 还硬编码(评审),一个被投毒网页或 MCP 响应就能让 Alfred 读 `.env` 再 `curl` 出去——无隔离、无污点、无 egress 闸;工具输出原样拼接、无 provenance。

**建议。** (a) **污点 + 围栏** —— 新 `src/security/taint.ts`:在 `ToolUseContext` 把 `webFetch`/MCP/`bash`-stdout 标不可信,包进明确标注的「不可信数据——非指令」块;更长远经**隔离子 agent**路由(§5 编排器让 dual-LLM *很自然*)。(b) **egress 白名单** —— 新 `src/security/egress.ts`,在 `webFetch.ts` + 沙箱强制。(c) **密钥脱敏** —— 新 `src/security/redact.ts`:从上下文*和*运行账本清掉 `.env`/钥匙形字符串。**结论:采纳 污点+围栏 + egress + 脱敏(P1, M);dual-LLM 隔离(P2,建在 §5)。** 差异化:**最高、最 on-brand**——「可审计的可靠」含「不可被劫持」,且*同行都没做*。

### 6.3 可观测、遥测与 eval

**最佳实践。** 把 agent 当生产软件:发 **OpenTelemetry GenAI 语义约定 span**——`gen_ai` span 覆盖模型调用、**agent 调用**、**workflow** span、**`execute_tool {gen_ai.tool.name}`**,带 token/cost/session 属性 [[O1]](#o1)——任意后端(Datadog/Honeycomb/Langfuse/LangSmith)无需定制即渲染轨迹 [[O2]](#o2)。再叠一个**eval harness**:重放录制轨迹、断言回归。这是「agent 做了点啥」与「这是它做了什么、花了多少的精确、可查询、可重放轨迹」之差。

**Alfred 的缺口。** Alfred 的 `CostTracker`(`src/cost/tracker.ts`)**从不被调用**(评审),也**完全没有结构化 tracing**——事件是 `console.log`/chalk 字符串(`src/repl.ts`)。无 span 模型、无轨迹导出、无 eval harness。可整个主张是*可证明*的可靠——目前因为没埋点而不可证明。

**建议。** (a) **OTel GenAI span** —— 新 `src/telemetry/otel.ts`:把每次 `provider.chat`、工具调用、编排器 agent/workflow 包进 `gen_ai.*` span;经 OTLP 导出(env 可选)。(b) **运行账本即 span 树** —— 把 §5.3 签名账本作为 OTel span 发出,使 HMAC 收据与可观测轨迹*同一份产物*(接 `trace-vault`)。(c) **eval harness** —— 新 `src/eval/`:重放录制会话,断言工具调用 / verify 退出码回归。**结论:采纳 OTel span + 账本即 span(P2, M);eval harness(P3)。** 差异化:**on-brand**——让「可证明的可靠」真正可导出、标准化。

### 6.4 模型路由与架构师–编辑器分工

**最佳实践。** 别什么都用一个模型。验证过的 coding-agent 模式是**架构师/编辑器分工**——强推理模型用散文*规划*改动;快而便宜的模型把它*套用*成精确编辑;Aider 报告这种分解拿到**SOTA** 编辑基准成绩 [[R1]](#r1)。再推广到**分层路由**(Claude Code:Opus 规划 / Sonnet 写 / Haiku 子 agent)与 **fallback 链**(过载时换 provider 重试)。模型按*子任务*选,不按会话选。

**Alfred 的缺口。** Alfred 有干净的 **provider 抽象**(`src/providers/`),但 loop **所有事都用一个 `config.model`**(`src/repl.ts` `resolveConfig`,默认 `glm-5.1`)——昂贵推理和便宜机械编辑付一样的钱;无架构师/编辑器分工、无按角色路由、无 fallback。这违反仓库自己的 `CLAUDE.md` Rule 6(token 预算)。

**建议。** (a) **按角色模型映射** —— 扩展 `QueryConfig`(`src/query/types.ts`)+ `src/config/manager.ts`,加 `{architect, editor, subagent}` 槽。(b) **harness 里的架构师/编辑器**(§5.3)—— implement 步用 architect 模型出计划、editor 模型转成 `fileEdit` 调用(编排器天然契合)。(c) **provider fallback** 在 retry 层(评审 R1.1)—— `overloaded` 时切到另一 provider。**结论:采纳 角色映射 + fallback(P1, M);harness 里的架构师/编辑器(P2,建在 §5)。** 差异化:**正确性 + 成本**——便宜、众所周知的胜利。

---

## 7. 其余取百家之长的脊柱(压缩)

这些在 `alfred-vs-the-field.md` 里详述;此处只给*「最佳」点的来源* + Alfred 挂载点。它们是头号引入所依赖的前置或对标工作。

| # | 维度 | 最佳实践(来源) | Alfred 挂载点 |
|---|---|---|---|
| 7.1 | 系统提示 | 按模型、可组合片段;量化 verbosity;ALL-CAPS git-NEVER;`AGENTS.md` 发现(Codex/Claude/Gemini) | `src/context/index.ts`、`src/context/claudemd.ts` —— **并接进去**(`src/repl.ts`,解锁记忆注入的 P0) |
| 7.2 | 工具编辑 | 内容锚定模糊匹配阶梯 + read-before-write/mtime(Codex `seek_sequence`、Claude Code) | `src/tools/fileEdit.ts`、`src/tools/lib/seekSequence.ts` |
| 7.3 | 权限/沙箱 | 两正交轴:OS 沙箱 × 审批策略;DENY 胜过 bypass;吓人 flag 在 root 下拒绝(Codex Seatbelt/Landlock、Claude `/sandbox`) | `src/permissions/types.ts`、新 `src/sandbox/`、`src/repl.ts`(停止硬编码 `bypass`) |
| 7.4 | 上下文/缓存 | 稳定前缀上 `cache_control`;真 `count_tokens`;user 边界 LLM 压缩;**context editing**(Anthropic) | `src/providers/anthropic.ts`、`src/compact/engine.ts` |
| 7.5 | Hooks | `PreToolUse/PostToolUse/…`,带 **exit-2-阻断** 契约(Claude Code/Codex) | 新 `src/hooks/`,在 `src/query/engine.ts` 派发 |
| 7.6 | MCP/skills | 忠实 MCP(真 schema、派生只读);**三级 skills** = 带渐进披露的过程记忆(Hermes 内置 91;Claude skills) | `src/mcp/types.ts`、`src/skills/loader.ts` —— **并加载它们**(`bootstrapExtensions`) |
| 7.7 | 自治 | headless NDJSON;类型化退出码;checkpoint/回滚(shadow-git);客观 verify 闸;反作弊 eval(Codex `exec`、Gemini exit-53、Aider `--auto-test`、SWE-bench Verified) | 新 `src/harness/*`、`src/index.ts` —— **实现为 §5.3 的 workflow** |

**注意 Hermes 点明的依赖:** memory + skills + 自改进循环只有在提示已接(7.1)且 harness 可执行(7.7/§5)后才*工作*。该排序驱动 §9。

---

## 8. 综合评估总表 —— 全方案一览

工时:**S** ≈ 小时 · **M** ≈ 1-2 天 · **L** ≈ 多天。「差异化」= 让 Alfred 脱颖而出,还是只到对标。

| 子系统 | 取自 | 结论 | 工时 | 差异化 |
|---|---|---|---|---|
| **记忆 v2(file-first 分层)** | Hermes + 你的 CLAUDE.md | **采纳——核心** | L | 高(策展+可验证) |
| 记忆 provider 缝 | Hermes 契约 | 采纳(仅接口) | M | 中 |
| 情景记录 → 账本 | Letta + provenant | **采纳** | M | **高** |
| 矛盾/陈旧 GC | Holographic + Hermes | 采纳 | M | 中 |
| Context editing | Anthropic | 采纳 | M | 对标 |
| Mem0/Zep 后端 | — | 改造(以后)/ 作默认拒绝 | — | 低 |
| **动态工作流运行时** | Claude Code | **采纳** | L | **高** |
| harness 即 workflow | Claude Code + Alfred 规范 | **采纳——旗舰** | M(在运行时上) | **最高** |
| best-of-N 客观奖励 | OpenHands | 采纳(P2) | M | 高 |
| 签名运行账本 | provenant/trace-vault | **采纳** | M | **最高** |
| **代码智能(repo-map + LSP)** | Aider / Kiro / LSP | **采纳** | M→L | **高(正确性)** |
| **Agent 层安全(lethal trifecta)** | Willison / CaMeL / dual-LLM | **采纳** | M | **最高(无人做)** |
| **OTel 可观测 + 账本即 span** | OTel GenAI / Langfuse | **采纳** | M | 高(on-brand) |
| **架构师/编辑器模型路由** | Aider / Claude Code | **采纳** | M | 高 ROI |
| 系统提示接好+充实 | Codex/Claude/Gemini | 采纳(P0) | S→M | 对标(解锁一切) |
| 模糊编辑 + mtime | Codex/Claude | 采纳(P0) | M | 对标 |
| OS 沙箱 + 审批轴 | Codex/Claude | 采纳(P0/P1) | L | 对标(门槛) |
| prompt 缓存 + 真 tokenizer | Anthropic | 采纳(P1) | M | 对标(成本) |
| Hooks(exit-2-阻断) | Claude/Codex | 采纳(P1) | L | 对标 |
| 忠实 MCP + 三级 skills | Gemini/Claude/Hermes | 采纳(P1/P2) | M | 中 |
| soul/人格文件 | Hermes | 改造(可选) | S | 低 |
| Crons | Hermes | 映射→harness | — | — |
| Workflow DSL/市场 | Claude Code | 推迟 | — | — |

---

## 9. 分阶段(依赖排序)

排序由一个事实强制(Hermes/§7 注):**记忆与编排都依赖「系统提示已接 + loop 稳健」。** 故评审的 P0 即此处 Phase 0。

**Phase 0 —— 地基(评审 P0,~1 周)。** 接系统提示(`src/repl.ts`)← *解锁记忆注入*;retry/backoff;停止硬编码 `bypass` + kill-list + path jail;模糊编辑 + mtime;真正被调用的压缩;`maxTokens`;类型化终止状态;**编辑后 tree-sitter 语法检查**(§6.1,便宜的正确性)。*验收:* `alfred -p "edit X"` 带真提示跑、扛 429、不会 `rm -rf`、不会静默溢出、不接受解析不了的编辑。

**Phase 1 —— 记忆 v2 + 正确性/安全/成本(§4、§6,~1-2 周)。** `LocalFileProvider` + `.alfred/memory/` 布局;四阶段流;情景记录;`memoryTool` CRUD;矛盾/陈旧 GC;context editing。**外加高紧急 §6 项:** repo map(§6.1)、污点+围栏 + egress 白名单 + 密钥脱敏(§6.2——鉴于三件套全开属紧急)、架构师/编辑器角色映射 + provider fallback(§6.4)。*验收:* A 会话教的事实 B 会话能召回;投毒网页无法外泄 `.env`;机械编辑跑在便宜模型上。

**Phase 2 —— 编排 + harness 融合 + 可观测(§5、§6.3,~1-2 周)。** 编排运行时;升格 `src/tools/agent.ts`;`workflows/autonomousRun.ts` = feature_list 状态机 + verify-fix 循环 + rubric 闸;shadow-git checkpoint/回滚;HMAC 签名账本作为 **OTel span** 发出(§6.3);编排器上的架构师/编辑器 + dual-LLM 隔离(§6.2/§6.4)。*验收:* `alfred run` 把 `feature_list.json` 跑绿,没真 exit-0 不准标 `passing`,产出可在任意 OTel 查看器打开的可重放签名账本。

**Phase 3 —— 对标打磨 + 可扩展(§7、§6 尾,持续)。** streaming;prompt 缓存 + 真 tokenizer;OS 沙箱;hooks 引擎;忠实 MCP;三级 skills;best-of-N;**LSP 客户端**(§6.1);**eval harness**(§6.3)。*验收:* 评审者会拿它跟 Codex/Gemini 平视。

**Phase 4 —— 旗舰 demo(moonshot)。** *Alfred-Bench:* Alfred 在「测试对模型隐藏、只由 harness 跑、双 FAIL→PASS / PASS→PASS 条件」的反作弊闸下,从空 `src/` 把自己的 `feature_list.json` 重建到全绿,产出一份签名、可重放的 bootstrap 轨迹。「看它在作弊不了的闸下重建自己」。

---

## 10. 风险与开放问题

- **策展质量 vs 噪声。** agent 自策展会囤垃圾。*缓解:* token 预算化 Core、矛盾/陈旧 GC、一个 `memory` 复查命令。(Hermes 自己的警告就是设计驱动。)
- **缓存 vs 动态记忆的张力。** 预取记忆改变前缀、伤 prompt-cache 命中率。*缓解:* Core(稳定)被缓存;预取走*只追加*的临时块、被 context-editing 清除——绝不前插。
- **workflow 在非确定性模型下的确定性。** *编排*确定;模型输出不确定。*缓解:* `trace-vault` 式重放断言编排器在*固定模型输出下*确定——把「运行可复现」与「agent 自报忠实」分开。
- **安全永远不会「做完」。** 污点+围栏降低但不消除注入风险(没有 harness 解决了它)。*缓解:* 纵深防御(egress 白名单 + 沙箱 + 隔离子 agent),并在文档里诚实写明残余风险,而非宣称免疫。
- **范围蔓延。** 这很多。*缓解:* 仅 Phase 0-1 就已让 Alfred 成为可信、诚实、*安全*的 agent;2+ 是差异化、可分阶段。
- **provider 建设成本。** 设计 memory provider 缝却只出本地后端,有抽象闲置风险。*缓解:* 接口保持小(8 方法);真要第二后端时再泛化。

---

## 11. 来源

<a id="h1"></a>[H1] Hermes Agent — Memory Providers(Nous Research 官方文档): https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers
<a id="h2"></a>[H2] Hermes Agent — 5-Pillar Architecture: https://www.mindstudio.ai/blog/hermes-agent-5-pillar-architecture-memory-skills-soul-crons · 记忆深析: https://www.glukhov.org/ai-systems/hermes/hermes-agent-memory-system/
<a id="m1"></a>[M1] MemGPT → Letta(OS 分层 agent 记忆;core/recall/archival;情景连贯): https://www.letta.com/ · MemGPT 论文: https://arxiv.org/abs/2310.08560
<a id="a1"></a>[A1] Anthropic — Memory tool(客户端文件目录,`memory_20250818`): https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
<a id="a2"></a>[A2] Anthropic — Context editing & 上下文管理(100 轮 eval 省 84% token): https://www.anthropic.com/news/context-management · https://platform.claude.com/docs/en/build-with-claude/context-editing
<a id="f1"></a>[F1] Agent 记忆全景 2026 — Letta vs Zep vs Mem0 vs LangMem/Cognee: https://agentmarketcap.ai/blog/2026/04/10/agent-memory-vendor-landscape-2026-letta-zep-mem0-langmem · Mem0: https://github.com/mem0ai/mem0 · Zep/Graphiti: https://github.com/getzep/graphiti
<a id="f2"></a>[F2] MemOS — 自演化记忆 OS(省 35% token): https://github.com/MemTensor/MemOS
<a id="f3"></a>[F3] Generative Agents(反思即记忆综合): https://arxiv.org/abs/2304.03442
<a id="c1"></a>[C1] Claude Code dynamic workflow / Agent SDK subagents & 编排: https://code.claude.com/docs/en/agent-sdk/subagents · streaming: https://code.claude.com/docs/en/agent-sdk/streaming-output
<a id="c2"></a>[C2] OpenHands — 推理期扩展 + 客观选择: https://www.openhands.dev/blog/sota-on-swe-bench-verified-with-inference-time-scaling-and-critic-model
<a id="c3"></a>[C3] Aider — lint/test 自愈循环(客观 verify 闸): https://aider.chat/docs/usage/lint-test.html
<a id="c4"></a>[C4] SWE-bench Verified(反作弊双通过条件): https://github.com/SWE-bench/SWE-bench
<a id="ci1"></a>[CI1] Aider — repo map(tree-sitter + PageRank 进 token 预算): https://aider.chat/2023/10/22/repomap.html · https://aider.chat/docs/repomap.html
<a id="ci2"></a>[CI2] LSP for coding agents(IDE 级智能,~50ms 调用点查询);Kiro CLI code intelligence: https://kiro.dev/docs/cli/code-intelligence/ · the/experts「Give your AI agent eyes」: https://tech-talk.the-experts.nl/give-your-ai-coding-agent-eyes-how-lsp-integration-transform-coding-agents-4ccae8444929
<a id="ci3"></a>[CI3] LSAP(Language Server Agent Protocol): https://github.com/lsp-client/LSAP · tree-sitter vs LSP: https://automadocs.com/blog/tree-sitter-vs-lsp-code-analysis
<a id="ci4"></a>[CI4] Hermes Agent 加入 repo-map + LSP: https://github.com/NousResearch/hermes-agent/issues/535 · https://github.com/NousResearch/hermes-agent/issues/516
<a id="s1"></a>[S1] Simon Willison — the lethal trifecta(私有数据 + 不可信内容 + 外泄): https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
<a id="s2"></a>[S2] dual-LLM + CaMeL 注入防御(及缺口:无主流 harness 落地): https://afine.com/llm-security-prompt-injection-camel · Willison「design patterns」: https://simonwillison.net/2025/Apr/11/camel/
<a id="s3"></a>[S3] Sophos — AI agent 部署的爆炸半径削减: https://www.sophos.com/en-us/blog/inside-the-lethal-trifecta-blast-radius-reduction-in-ai-agent-deployments
<a id="o1"></a>[O1] OpenTelemetry — GenAI agent & framework spans(语义约定): https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/
<a id="o2"></a>[O2] Datadog — 原生 OTel GenAI 语义约定支持: https://www.datadoghq.com/blog/llm-otel-semantic-convention/
<a id="r1"></a>[R1] Aider — 架构师/编辑器模式(强模型规划、快模型编辑;SOTA 编辑基准): https://aider.chat/2024/09/26/architect.html · https://aider.chat/docs/usage/modes.html

> 完整逐维行业引用(50 来源)见配套 `alfred-vs-the-field.md` §6。
