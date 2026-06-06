# ADR 0004 — 可观测、遥测与 eval

[English](./0004-observability-and-evals.md) | **中文**

- **状态:** Proposed
- **日期:** 2026-06-05
- **关联:** [ADR 0001](./0001-target-architecture.zh-CN.md) · [`improvement-proposal.zh-CN.md` §6.3](../improvement-proposal.zh-CN.md)

## 背景

Alfred 的整个主张是*可证明的*可靠性,但什么都没埋点:`CostTracker`(`src/cost/tracker.ts`)从不被调用(评审),事件是 `console.log`/chalk 字符串(`src/repl.ts`)。没有 span 模型、没有轨迹导出、没有 eval harness——所以可靠性主张目前*无法证明*。

业界标准是 **OpenTelemetry GenAI 语义约定**:`gen_ai` span 覆盖模型调用、agent 调用、workflow span、`execute_tool {gen_ai.tool.name}`,带 token/cost/session 属性。任意后端(Datadog、Honeycomb、Langfuse、LangSmith)无需定制代码即可渲染。

## 决策

1. **OTel GenAI span** —— `src/telemetry/otel.ts`:把每次 `provider.chat`、工具调用、编排器 agent/workflow 包进 `gen_ai.*` span;经 OTLP 导出(env 可选开启)。
2. **运行账本即 span 树** —— 把 [ADR 0001](./0001-target-architecture.zh-CN.md)/§5.3 的 HMAC 签名账本作为 OTel span 发出,使收据与可观测轨迹*同一份产物*(接 `trace-vault`)。
3. **eval harness** —— `src/eval/`:重放录制会话,断言工具调用 / verify 退出码的回归。

## 影响

- **正面**:让「可证明的可靠」真正可导出、标准化;一份产物同时服务审计(HMAC)与可观测(OTel);可对 agent 自身跑回归 eval。
- **负面/成本**:引入 OTel SDK 依赖;span 要避免泄密(与 [ADR 0003](./0003-agent-layer-security.zh-CN.md) 脱敏协同);eval harness 需要录制会话语料。
- **分阶段**:OTel span + 账本即 span P2(M);eval harness P3。

## 备选方案

- **只做自定义 JSON 日志**:拒绝;等于重造一个更差、不可移植的 OTel 子集,且无免费后端支持。
- **以托管 tracing SaaS 为默认**:拒绝;违反本地优先;OTLP 导出可选,指向用户选择的任意目标(含本地 collector)。

## 参考

见 [`improvement-proposal.zh-CN.md` §11](../improvement-proposal.zh-CN.md#11-来源) —— [O1] OTel GenAI agent spans、[O2] Datadog OTel GenAI 支持。
