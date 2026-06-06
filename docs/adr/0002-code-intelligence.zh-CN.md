# ADR 0002 — 代码智能:repo map + LSP

[English](./0002-code-intelligence.md) | **中文**

- **状态:** Proposed
- **日期:** 2026-06-05
- **关联:** [ADR 0001](./0001-target-architecture.zh-CN.md) · [`improvement-proposal.zh-CN.md` §6.1](../improvement-proposal.zh-CN.md)

## 背景

Alfred 唯一的代码导航工具是 `glob` 和 `grep`(`src/tools/glob.ts`、`src/tools/grep.ts`)——纯文本搜索,零结构/语义理解。它答不出「这个符号在哪定义/被谁用」,看不到类型,且 `src/tools/fileEdit.ts` 可能写出语法损坏的代码,只能等 `bun test`(若有测试覆盖)才发现。大仓库里模型只能盲 grep、烧 turn。

业界有两个互补答案:Aider 的 **repo map**(tree-sitter 抽 `def`/`ref` 标签 → 符号图 → **PageRank** 进固定 token 预算),给低成本的全仓结构感知;以及 **LSP**(跳定义/找引用/hover 类型/诊断),给 IDE 级语义精度(查全部调用点 ~50ms,而递归 grep 要几十秒)。Hermes Agent 也在独立加入这两者(issue #535、#516)。

## 决策

分三步加入代码智能层:

1. **repo map** —— `src/context/repomap.ts`:tree-sitter(`web-tree-sitter`)+ PageRank 进 token 预算,注入到记忆 Core 旁边([ADR 0001](./0001-target-architecture.zh-CN.md)/§4)。
2. **编辑后 tree-sitter 语法检查** —— 在 `src/tools/fileEdit.ts`:结果解析不通过就拒绝。便宜,在 verify 循环前消灭一整类失败。
3. **LSP 客户端** —— `src/tools/lsp/`:把 `definition`/`references`/`hover`/`diagnostics` 暴露为工具,诊断喂进 harness 的 verify 循环。

## 影响

- **正面**:更少幻觉/损坏编辑(正确性);探索便宜,模型敢探索;诊断比跑全测更快当闸。
- **负面/成本**:tree-sitter 语法包与 LSP 客户端引入依赖与每语言接线;repo map 需在文件变更时失效重建。
- **分阶段**:编辑后解析检查 P0-邻近(S);repo map P1(M);LSP 客户端 P2(M→L)。

## 备选方案

- **嵌入索引(Cursor 式)**:作为默认拒绝;基础设施更重、不如确定性符号图可检视;PageRank 不够时再议。
- **维持纯 grep**:拒绝;实测正确性差距大,而 repo-map 成本不高。

## 参考

见 [`improvement-proposal.zh-CN.md` §11](../improvement-proposal.zh-CN.md#11-来源) —— [CI1] Aider repo map、[CI2] LSP for agents / Kiro、[CI3] LSAP 与 tree-sitter-vs-LSP、[CI4] Hermes #535/#516。
