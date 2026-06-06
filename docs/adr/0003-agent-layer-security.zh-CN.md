# ADR 0003 — Agent 层安全:注入与外泄防御

[English](./0003-agent-layer-security.md) | **中文**

- **状态:** Proposed
- **日期:** 2026-06-05
- **关联:** [ADR 0001](./0001-target-architecture.zh-CN.md) · [`improvement-proposal.zh-CN.md` §6.2](../improvement-proposal.zh-CN.md)

## 背景

这与 OS 沙箱不同([ADR 0001](./0001-target-architecture.zh-CN.md)/§7.3 约束*进程能做什么*);本 ADR 约束*不可信内容能让 agent 做什么*。威胁是 Simon Willison 的 **lethal trifecta(致命三件套)**——私有数据 + 不可信内容 + 外泄通道同处一个上下文;任意两个安全,三个齐了就可被利用。

Alfred 当前**三件套全开**:读私有仓库数据;摄入不可信内容(`src/tools/webFetch.ts` 抓任意 URL;MCP 桥把服务器输出原样灌进上下文);有外泄通道(无 egress 策略的 `bash`/`webFetch`)。`mode:"bypass"` 还是硬编码(评审),一个被投毒的网页或 MCP 响应就能指挥 Alfred 读 `.env` 再 `curl` 出去。工具输出原样拼接、无 provenance。值得注意:**没有任何主流 harness——Claude Code、Cursor、Hermes、Copilot、Gemini CLI——已落地这些防御**,所以这是真正的差异化赛道。

## 决策

在内容层做纵深防御:

1. **污点 + 围栏** —— `src/security/taint.ts`:在 `ToolUseContext` 里把 `webFetch`/MCP/`bash`-stdout 标为不可信,包进明确标注的「不可信数据——非指令」块;更长远经**隔离子 agent**(dual-LLM 模式,在 [ADR 0001](./0001-target-architecture.zh-CN.md)/§5 编排器上很自然)路由。
2. **egress 白名单** —— `src/security/egress.ts`:在 `webFetch.ts` 和沙箱里强制;阻断到非白名单主机的外泄。
3. **密钥脱敏** —— `src/security/redact.ts`:从上下文*和*运行账本里清掉 `.env`/钥匙形字符串。

## 影响

- **正面**:堵住当前构建上最危险的真实攻击;高度 on-brand(「可审计的可靠」包含「不可被劫持」);同行都没做的功能。
- **负面/成本**:污点追踪要在 `ToolUseContext` 里铺管线;egress 白名单过严会挡正常抓取(需配置);注入永远不会被彻底解决——这是降低而非消除风险。
- **分阶段**:污点+围栏+egress+脱敏 P1,鉴于三件套全开属高紧急;dual-LLM 隔离 P2(建在 §5 上)。

## 备选方案

- **只靠 OS 沙箱**:拒绝;沙箱约束进程,不约束被污染内容用 agent *被允许*的工具(比如一个被允许的 `curl`)去做什么。
- **完整 CaMeL(受限 Python + 策略引擎)**:推迟;强大但重、生产未验证;先采纳 dual-LLM 子集。

## 参考

见 [`improvement-proposal.zh-CN.md` §11](../improvement-proposal.zh-CN.md#11-来源) —— [S1] lethal trifecta(Willison)、[S2] dual-LLM + CaMeL、[S3] blast-radius reduction(Sophos)。
