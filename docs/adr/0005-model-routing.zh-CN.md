# ADR 0005 — 模型路由:架构师/编辑器分工

[English](./0005-model-routing.md) | **中文**

- **状态:** Proposed
- **日期:** 2026-06-05
- **关联:** [ADR 0001](./0001-target-architecture.zh-CN.md) · [`improvement-proposal.zh-CN.md` §6.4](../improvement-proposal.zh-CN.md)

## 背景

Alfred 有干净的 provider 抽象(`src/providers/`),但 loop **所有事都用同一个 `config.model`**(`src/repl.ts` `resolveConfig`,默认 `glm-5.1`)——昂贵的推理和便宜的机械编辑付一样的模型钱。没有架构师/编辑器分工、没有按角色路由、没有 fallback。这违反仓库自己的 `CLAUDE.md` Rule 6(token 预算是硬约束)。

业界验证过的 coding-agent 模式是**架构师/编辑器分工**:强推理模型用散文*规划*改动;快而便宜的模型把它*套用*成精确编辑。Aider 报告这种分解拿到 SOTA 编辑基准成绩。再推广到分层路由(plan / code / 子 agent 三档)与 fallback 链。

## 决策

1. **按角色的模型映射** —— 扩展 `QueryConfig`(`src/query/types.ts`)+ `src/config/manager.ts`,加 `{architect, editor, subagent}` 三个槽,各自解析到 provider+model。
2. **harness 里的架构师/编辑器** —— 在 [ADR 0001](./0001-target-architecture.zh-CN.md)/§5.3 的 verify-fix 循环里,architect 模型出方案、editor 模型转成 `fileEdit` 调用。
3. **provider fallback** —— 在 retry 层(评审 R1.1):遇 `overloaded` 时切到另一个 provider。

## 影响

- **正面**:更高编辑准确率(已验证)*且*更低成本(便宜模型干机械活);遵守仓库 token 预算规则;靠 fallback 提升韧性。
- **负面/成本**:配置面变大;一个任务两个模型意味着两套 prompt 格式要维护;路由逻辑须保持确定性([ADR 0001](./0001-target-architecture.zh-CN.md) P3),不由模型决定。
- **分阶段**:角色映射 + fallback P1(M);harness 里的架构师/编辑器 P2(建在 §5 上)。

## 备选方案

- **学习型路由(RouteLLM 式)**:推迟;单用户规模下相对静态角色映射边际收益有限,却多一个模型/依赖。
- **所有事一个强模型**:拒绝;违反 token 预算规则,且白白丢掉已实测的架构师/编辑器准确率增益。

## 参考

见 [`improvement-proposal.zh-CN.md` §11](../improvement-proposal.zh-CN.md#11-来源) —— [R1] Aider 架构师/编辑器模式。
