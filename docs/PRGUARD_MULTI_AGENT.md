# PRGuard Multi-Agent 深度编排

批次七将 PRGuard 从“固定三个 Prompt 并行调用”升级为完整的 Router—Specialist—Blackboard—Critic/Judge 编排系统。

```text
Diff / Repository / Memory
          |
          v
   Risk-aware Router -----> Global Budget Controller
          |                         |
          v                         v
 Selected Specialists -> Unified Specialist Runtime
          |              (timeout/retry/checkpoint/resume)
          v
   Versioned Blackboard
          |
          v
 Dedup + Support Aggregator
          |
          v
 Critic/Judge + Conflict Arbitration
          |
          v
 Selective Evidence Verifier -> Human Approval -> Patch
```

## 动态 Router

Router 根据变更文件、Diff 内容、变更规模和上下文完整度选择专家：

- Security Agent：鉴权、注入、命令执行、密钥和文件系统边界；
- Reliability Agent：异常、重试、超时、并发、事务和资源生命周期；
- Code Quality Agent：作为基础回归审查，检查兼容性、测试缺口和脆弱逻辑。

文档类低风险变更可以只派发 Code Quality Agent；带鉴权信号的变更派发 Security + Code Quality；并发、重试或超时变更派发 Reliability + Code Quality。Diff 信息不足或变更面过大时自动启用全部专家。路由选择、跳过专家、命中信号和原因都会进入结果与 Run Trace。

## 统一 Specialist Runtime

所有 PRGuard Specialist 通过同一运行时执行，统一处理：

- AbortSignal 取消；
- 单次尝试超时；
- 独立重试；
- Planning、Executing、Completed、Failed Checkpoint；
- 按输入 Hash 恢复已完成专家；
- 单个专家失败隔离；
- 并发槽位和全局预算。

恢复键包含 Diff、模型、长期记忆版本、已选专家和 Pipeline 版本。输入变化后不会错误复用旧结论。

## 共享 Blackboard

Blackboard 是带版本号的追加式协作状态，保存：

- Router 选择和跳过的专家；
- 每个专家提交的 Finding 及时间；
- 当前成功和失败专家；
- 重叠 Finding 的冲突集合；
- Critic/Judge 的接受、拒绝及理由。

失败专家在重试成功后会从当前失败集合移除，但失败尝试仍保留在 Trace。Blackboard Snapshot 被写入最终聚合元数据，能够解释“哪些专家参与、发生过什么分歧、最后为何保留该 Finding”。

## Critic/Judge 与冲突仲裁

聚合器先按文件、类别和邻近代码行去重并合并 Evidence。未获得多专家支持的 Finding，以及位置重叠但类别、严重级别或修复建议冲突的 Finding，会进入 Critic/Judge。

Judge 默认采用混合模式：优先调用模型输出结构化 verdict；模型超时、预算耗尽或返回非法结构时，退化到确定性裁决。确定性策略综合严重级别、置信度、支持专家数和证据，并在冲突中选择更高严重级别/置信度的结论。裁决结果不会静默丢弃，会保存 rejected ID、理由、执行模式和错误。

## 全局预算控制

`OrchestrationBudgetController` 对整个编排而非单个 Agent 统一限制：

- 模型调用次数；
- 输入 Token；
- 输出 Token；
- 总运行时长；
- 最大并发 Agent 数。

预算在模型调用前原子预留，并在响应后累计 Provider Usage。专家重试、Single-Agent Fallback 和 Model Judge 共用同一预算，避免降级路径绕过成本限制。最终结果的 `orchestration.budget` 给出实际使用量、峰值并发和剩余调用次数。

部署时可通过 `PR_GUARD_MAX_SPECIALISTS`、`PR_GUARD_ORCHESTRATION_MAX_MODEL_CALLS`、`PR_GUARD_ORCHESTRATION_MAX_INPUT_TOKENS`、`PR_GUARD_ORCHESTRATION_MAX_OUTPUT_TOKENS`、`PR_GUARD_ORCHESTRATION_MAX_DURATION_MS`、`PR_GUARD_ORCHESTRATION_MAX_CONCURRENT_AGENTS` 和 `PR_GUARD_CRITIC_JUDGE_ENABLED` 调整。API 与 Worker 的默认 Review 路径会读取这些配置，不需要改代码。

## 失败与降级语义

- 单个 Specialist 失败：保留其他专家结果；
- Specialist 重试成功：继续正常聚合；
- 所有 Specialist 失败：在预算允许时执行 Single-Agent Fallback；
- Model Judge 失败：记录错误并执行确定性 Judge；
- 全局取消：立即停止，不执行 Fallback；
- 预算耗尽：失败关闭，不无限追加模型调用。

运行方式：

```powershell
npm.cmd run dev -- pr review --base HEAD~1 --multi-agent --json
```

核心测试位于 `test/orchestration.test.ts` 和 `test/prguard-multi-review.test.ts`，覆盖动态路由、共享预算、并发限制、Blackboard 冲突、模型裁决、Fallback 和 Specialist Checkpoint 恢复。
