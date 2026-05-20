# AGENTS.md

这个仓库面向长时运行的 coding agent 工作流。目标不是尽可能快地产出代码，而是让每一轮会话结束后，下一个会话仍然能无猜测地继续工作。

## 开工流程

写代码前先做这些事：

1. 用 `pwd` 确认当前目录。
2. 读取 `claude-progress.md`，了解最新已验证状态和下一步。
3. 读取 `feature_list.json`，选择优先级最高的未完成功能。
4. 用 `git log --oneline -5` 看最近提交。
5. 运行 `./init.sh`。
6. 运行 `touch .harness/.session-start` 刷新会话标记。
7. 在开始新功能前，先跑必需的 smoke test 或端到端验证。

如果基础验证一开始就失败，先修基础状态，不要在坏的起点上继续叠新功能。

## 工作规则

- 一次只做一个功能。
- 不要因为”代码已经写了”就把功能标记为完成。
- 除非为了消除当前 blocker 的窄范围修复，否则不要扩大到其他功能。
- 实现过程中不要悄悄改弱验证规则。
- 优先依赖仓库里的持久化文件，而不是聊天记录。
- 如果 `feature_list.json` 的 `features` 为空（`_status` 为 `awaiting_requirements`），先和用户讨论需求，把大目标拆解成可验证的小功能，写入 `features` 数组，将 `_status` 改为 `”active”`。

## 必需文件

- `feature_list.json`：功能状态的唯一事实来源
- `claude-progress.md`：会话进度、当前已验证状态与跨会话交接摘要（已合并 session-handoff 功能）
- `init.sh`：统一的启动与验证入口

## 完成定义

一个功能只有在以下条件都满足时才算完成：

- 目标行为已经实现
- 要求的验证真的跑过
- 证据记录在 `feature_list.json` 或 `claude-progress.md`
- 仓库仍然能按标准启动路径重新开始工作

## 收尾

结束会话前：

1. 更新 `claude-progress.md`
2. 更新 `feature_list.json`
3. 记录仍未解决的风险或 blocker
4. 在工作处于安全状态后，用清晰的提交信息提交
5. 保证下一轮会话可以直接运行 `./init.sh`

## 自治工作模式

### 触发条件

当指令中包含以下任一关键词时进入自治模式：
- "开始工作"、"继续"、"做完剩下的"、"hands-off"
- 英文：autonomous、hands-off、continue all、finish remaining

### 自治循环

1. 按优先级从 feature_list.json 选取下一个未完成功能
2. 实现该功能
3. 运行验证
4. 如果验证通过 → 标记 passing，提交，进入下一个功能
5. 如果验证失败 → 修复，重试（同一功能最多 5 次）
6. 如果 5 次仍失败 → 标记 blocked，记录原因，跳到下一个功能
7. 如果连续 2 个功能 blocked → 停止自治，报告状态

### 停止条件

- 所有功能 passing
- 连续 2 个功能 blocked
- 环境基础验证失败
- Token 预算不足
- 检测到循环重复（连续 2 次提交的 diff 相似度 > 80%）

### 停止后的报告

自治模式结束时，必须输出一份结构化报告：

## 自治工作总结

- 运行时长：X 分钟
- 完成功能数：N / M
- passing 功能列表：[id1, id2, ...]
- blocked 功能列表：[id1, ...]
  - 每个的 blocker 原因：
- 未开始功能列表：[id1, ...]
- 总迭代次数：X
- 总提交数：X
- 需要人工处理的事项：[...]

## 参考文件

以下文件按需读取，不需要每次都读：

| 文件 | 什么时候读 |
|------|-----------|
| `.harness/reference/method-map.md` | 遇到反复失败时 |
| `.harness/reference/initializer-agent-playbook.md` | 首次初始化项目时 |
| `.harness/reference/coding-agent-startup-flow.md` | 不确定开工流程时 |
| `.harness/reference/prompt-calibration.md` | 调整根指令时 |
| `.harness/templates/autonomous-loop.md` | 进入自治模式时 |
| `.harness/templates/self-eval-trigger.md` | 自治模式需要自我评审时 |
| `.harness/plans/active/` | 接手复杂任务时 |

## 结构验证

当怀疑 harness 文件不完整时，运行：

    harness check
