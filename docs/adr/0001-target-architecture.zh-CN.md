# ADR 0001 — 目标架构:可验证的自治 coding agent

[English](./0001-target-architecture.md) | **中文**

- **状态:** Proposed(提议)
- **日期:** 2026-06-05
- **配套文档:** [`improvement-proposal.zh-CN.md`](../improvement-proposal.zh-CN.md)(完整设计)· [`alfred-vs-the-field.md`](../alfred-vs-the-field.md)(本决策所基于的评审)

## 背景

Alfred 起步是 Claude Code 风格的 CLI coding agent。对标 Codex CLI / Gemini CLI / Claude Code 的代码级评审发现:骨架很干净(`buildTool()` 能力位工厂、`AsyncGenerator` query loop、provider 抽象),而且自治 harness 规范(本仓库 `CLAUDE.md` / `feature_list.json` / `evaluator-rubric.md` / `.harness/`)比三个参照 CLI 都更有主见。

但存在一致的**「库写好了却没接线」**模式:系统提示构建器、streaming、压缩、cost 追踪、MCP/skills/plugins loader 都以代码形式存在却**无运行时调用方**,头号卖点「自治」只活在散文里。

战略岔路:**(a)** 去追 streaming/sandbox/caching 的对标;**(b)** 接好骨架,押注这个仓库已设计得比同行更好的东西——*可强制、可审计的自治*。

## 决策

采纳 **(b)**:把 Alfred 定位为**可验证的自治 coding agent**,走「取百家之长」的目标架构而非克隆。具体:

1. **记忆 v2** —— file-first、分层(core/recall/archival)、agent 自策展、provider 抽象,融合 Hermes Agent(Nous)、MemGPT/Letta、Anthropic memory tool + context editing,以及本仓库 `CLAUDE.md` 的 file-per-fact 范式。默认本地 `LocalFileProvider`(SQLite FTS5);给 Mem0/Zep 留缝但不内置。
2. **动态工作流** —— 确定性 `agent()/pipeline()/parallel()` 编排运行时(Claude Code 模型),建在现有 query 引擎 + Zod 之上,journal 兼作重放磁带。
3. **harness 即 workflow** —— 把 `CLAUDE.md` 的自治循环实现为内置 workflow:`feature_list.json` 状态机 → 对 `init.sh` 的 `VERIFY_CMD`(`bun test`)退出码做 verify-fix 内层循环 → 代码强制的 rubric 闸 → checkpoint/回滚 → **HMAC 签名、可重放的运行账本**。
4. **四个交叉领域**(各一条 ADR)—— 代码智能(repo-map + LSP,[ADR 0002](./0002-code-intelligence.zh-CN.md))、Agent 层安全(lethal-trifecta 防御,[ADR 0003](./0003-agent-layer-security.zh-CN.md))、可观测(OTel GenAI span + 账本即 span,[ADR 0004](./0004-observability-and-evals.zh-CN.md))、模型路由(架构师/编辑器分工,[ADR 0005](./0005-model-routing.zh-CN.md))。

横切原则:**本地优先且可检视**、**provider 抽象**、**确定性控制流**(模型填格子、格子手工接线——契合本仓库 `CLAUDE.md` Rule 5「代码能回答的让代码回答」)、**agent 提议/机器验证**、**每次运行留收据**。

## 影响

**正面**:头号主张变成*可执行、可审计*;接入 `trace-vault`/`provenant`「可证明的 agent 可靠性」组合;记忆选型与两套独立系统(Hermes + 本仓库 CLAUDE.md)收敛,降低风险;复用现有资产而非重写。

**负面/成本**:范围比纯对标大,需分阶段;memory provider 抽象的第二后端短期可能不落地(留小接口缓解);预取记忆与 prompt-cache 命中率有张力(core 稳定可缓存、预取走 append-only 并被 context-editing 清除)。

**排序(依赖驱动)**:记忆与编排都依赖「系统提示已接 + loop 稳健」,故评审的 P0 即此处 Phase 0 → Phase 1 记忆+正确性/安全/成本 → Phase 2 编排+harness+可观测 → Phase 3 对标打磨 → Phase 4 Alfred-Bench 自重建。

## 备选方案

- **纯克隆对标**:拒绝,无差异化。
- **云托管记忆/编排(Zep 图、托管向量库为默认)**:作为基础拒绝,违反本地优先;保留为可选 provider adapter。
- **全套 MemGPT OS 模拟 / day-one 通用 workflow DSL**:拒绝;只取分层与编排原语,重型通用性等真实需求出现再说(Rule 2 最简优先)。

## 相关 ADR

- [0002 — 代码智能(repo-map + LSP)](./0002-code-intelligence.zh-CN.md)
- [0003 — Agent 层安全(lethal trifecta)](./0003-agent-layer-security.zh-CN.md)
- [0004 — 可观测与 eval(OTel GenAI)](./0004-observability-and-evals.zh-CN.md)
- [0005 — 模型路由(架构师/编辑器分工)](./0005-model-routing.zh-CN.md)

## 参考

完整引用见 [`improvement-proposal.zh-CN.md` §11](../improvement-proposal.zh-CN.md#11-来源) 与 [`alfred-vs-the-field.md` §6](../alfred-vs-the-field.md)。
