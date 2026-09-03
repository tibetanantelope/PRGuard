# Agent Runtime 与断点恢复

PRGuard 的 Runtime 不只保存聊天记录，还持久化“任务执行到哪里、正在做什么、哪些副作用可能已经发生”。恢复入口会继续同一个 Run，而不是把历史消息装入一个全新 Run。

## 可执行计划

默认 Planner 根据任务类型建立依赖 DAG。每个步骤包含：

- `capability`：reasoning、read、write、verify、report 或 recovery；
- `dependsOn`：前置步骤 ID；
- `acceptanceCriteria`：步骤完成条件；
- `status`：pending、running、completed、failed 或 skipped；
- `attempts`、`idempotencyKey`、`resultRef` 和错误信息。

Agent Loop 在真实工具调用前激活能力匹配的可执行步骤，成功后记录结果引用并推进后继步骤；失败后将当前步骤标为 failed，生成 recovery 步骤并重建尚未完成的依赖关系。每次安装或重规划都会执行重复 ID、缺失依赖和 DAG 环校验；同一失败步骤最多尝试三次，之后标记为 skipped 并保留失败原因。计划状态会注入模型上下文，同时写入 Working Memory 和 Checkpoint，因此不是只用于展示的静态清单。

## Checkpoint 内容与恢复入口

Checkpoint 以不可变版本保存：

- Runtime phase、status、budget 和 usage；
- 完整 Working Memory 与计划 DAG；
- 当前消息快照；
- Pending Action、artifact reference 和阶段输出；
- 输入哈希与提交幂等键。

TTY 中 `/resume` 用于恢复历史会话，`/continue-run` 则查找当前会话最新的未完成 Run，恢复其消息快照、Run ID、Working Memory 和执行阶段。已经 completed 的较新 Run 不会遮蔽更早仍未完成的 Run。

## 工具执行账本

每次工具调用在执行前写入持久化 JSONL 账本，键由 Run ID 和 tool call ID 组成，状态为 started、completed、failed 或 indeterminate。Checkpoint 中的 Pending Action 保存工具名、输入、风险等级和对应计划步骤。

崩溃恢复策略是：

| 崩溃时状态 | 恢复行为 |
|---|---|
| 账本已有 completed 结果 | 不重复调用工具，直接复用结果 |
| read_only 调用只有 started 或缺少终态 | 允许安全重试，并写入新终态 |
| state_changing / external_side_effect 调用结果不确定 | 标记 indeterminate，不自动重放，向 Agent 返回显式错误并进入 recovery 计划 |
| Checkpoint 缺少旧版本执行元数据 | 不猜测、不重放，记录可诊断错误 |

这里刻意不宣称任意外部系统上的“全局 exactly-once”。在没有下游幂等接口或事务协调器时，崩溃可能发生在外部副作用成功后、账本完成记录写入前。此时自动重放会制造重复副作用，所以 Runtime 选择保守的 at-most-once 恢复；GitHub 评论和 Check Run 等已知接口另外使用 marker / external ID 实现业务幂等。

## Multi-Agent Specialist 恢复

Security、Reliability 和 Code Quality Specialist 分别保存 checkpoint。缓存键覆盖 PR 输入、Diff、模型、Pipeline 版本及注入的长期记忆。某个 Specialist 超时或进程崩溃后，再次执行只调用未完成或失败的 Specialist，已完成且输出通过 Schema 校验的结果直接进入 Blackboard 聚合。

## 已覆盖的故障场景

自动化测试覆盖：

- 模型中断后从同一 Run 继续；
- Checkpoint 损坏或临时文件残留时选择最新有效版本；
- 已完成副作用不重复执行；
- 结果不确定的写操作不自动重放；
- 未完成的只读操作只重试一次；
- Planner 步骤随真实工具执行推进，失败后依赖可继续调度；
- Multi-Agent 部分成功时只恢复已完成 Specialist；
- completed Run 与 incomplete Run 并存时，TTY 选择后者继续。
