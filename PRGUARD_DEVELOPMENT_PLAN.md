# PRGuard 分阶段开发计划

> 项目定位：面向研发流程的 PR 风险治理与安全修复 Agent。
>
> 本计划以 Redis Streams 可靠任务系统为第一优先级，随后建设 Agent Runtime、Patch 安全边界、评测体系、GitHub 闭环和简历展示。

## 总体目标

```text
GitHub PR
  -> Webhook
  -> Review Job
  -> Redis Streams
  -> Review Worker
  -> Multi-Agent Risk Review
  -> Evidence Verifier
  -> Human Approval
  -> Patch Agent
  -> Isolated Test Verification
  -> Fixed / Rolled Back
  -> GitHub Check / Comment
```

项目重点不是继续堆叠 Agent 数量，而是证明 Agent 能够在真实研发流程中稳定完成任务，并且每一步都有证据、状态和结果。

## 当前基线

目前已经具备：

- PR Diff 解析与代码风险审查；
- Security、Reliability、Code Quality 多 Agent 审查；
- MySQL 业务数据持久化；
- Redis Streams 异步任务队列；
- API Server + Worker 架构；
- Run Trace 与 Prometheus 监控；
- GitHub PR Webhook 和 Diff 拉取；
- 人工确认式 Patch 生成；
- Patch 应用、测试验证和失败自动回滚；
- Admin 管理页面；
- 离线规则基线和评测框架。

当前测试基线：`npm.cmd run check` 和 `npm.cmd test` 均通过。

---

## 阶段一：Redis Streams 可靠任务系统

### 目标

把 Redis Streams 从“能够投递任务”提升为“Worker 崩溃后可以恢复、任务不会重复造成副作用、任务状态可观测”的可靠任务系统。

### 主要任务

#### Pending 消息恢复

- 记录 Consumer 的消费时间和最后心跳；
- 定期查询 Pending Entries；
- 使用 `XAUTOCLAIM` 接管超时未确认消息；
- 区分正常运行中的任务和失联 Worker 的任务；
- 记录接管次数和接管原因。

#### 消费者生命周期

- 为每个 Worker 生成稳定的 consumer identity；
- 记录 Worker 启动、心跳、停止和异常退出；
- 增加消费者超时配置；
- 优雅关闭时停止拉取新任务并完成当前任务。

#### Job 幂等

- 以 `jobId` 作为业务幂等键；
- 处理重复投递和重复消费；
- 使用状态条件更新避免两个 Worker 同时执行同一个 Job；
- 已完成 Job 重复消费时直接 ACK，不重复调用模型。

#### 重试与死信

- 区分 transient error 和 permanent error；
- 记录失败类型、attempt、worker 和时间；
- 支持指数退避；
- 超过最大次数后进入 Dead Letter Stream；
- 增加死信查询和重新入队能力。

#### 队列监控

增加 Prometheus 指标：

- `prguard_queue_enqueued_total`；
- `prguard_queue_consumed_total`；
- `prguard_queue_acked_total`；
- `prguard_queue_reclaimed_total`；
- `prguard_queue_dead_letter_total`；
- `prguard_queue_pending_jobs`；
- `prguard_queue_oldest_pending_age_ms`。

### 交付物

- Redis Streams reclaim 实现；
- Worker 生命周期管理；
- Job 幂等状态机；
- Dead Letter 查询和重试接口；
- Redis 可靠性说明文档；
- Worker 崩溃恢复集成测试。

### 验收标准

- Worker 在任务执行中退出，新 Worker 可以接管任务；
- 同一个 Job 不会并发执行两次；
- 重复消息不会重复调用模型；
- 临时失败可以退避重试，永久失败进入死信；
- Redis Pending、积压和死信都有指标；
- Redis 测试可以在 Docker Compose 环境中重复运行。

---

## 阶段二：Agent Runtime 取消、超时与恢复

### 目标

让超时和取消真正停止底层模型请求、工具调用和子进程，而不是只让外层 Promise 返回超时。

### 主要任务

- 将 `AbortSignal` 从 Worker 贯穿到 Job、Service、Agent Loop、Model Adapter 和 Tool；
- 为模型请求增加可取消的 HTTP 请求；
- 为工具调用增加取消处理；
- 为 Review Job 增加硬超时和软超时；
- 心跳停止后由 Worker 接管任务；
- 增加 checkpoint 和 resume 边界；
- 区分超时、主动取消、模型失败和工具失败；
- 记录每种失败类型的 Trace 和指标。

### 交付物与验收

- 统一取消协议；
- `cancelled`、`timed_out`、`failed` 状态；
- 可恢复的 Review Trace；
- 超时、取消和恢复集成测试；
- 超时后模型请求和工具调用确实终止。

---

## 阶段三：安全 Patch 与测试隔离

### 目标

让 Agent 生成的补丁在受控环境中应用和验证，避免污染用户工作区或执行危险命令。

### 主要任务

- 使用临时 Git worktree 执行 Patch；
- 校验补丁文件范围、路径和符号链接；
- 校验 Patch 只能修改选中的 Finding 相关文件；
- 测试命令增加超时、输出大小和退出状态限制；
- 完善 Patch 状态机：

```text
pending -> approved -> applying -> verifying -> applied
                                      \-> rolled_back
```

- 保存 Patch、Verification 和 Approval 记录；
- 修复失败后清理 worktree；
- 支持修复前后重新 Review。

### 验收标准

- Patch 和测试默认不修改用户当前工作区；
- 测试超时会终止进程并回滚；
- 非法命令、非法路径和越界文件会被拒绝；
- 回滚失败会进入明确的人工处理状态；
- 每次修复都有完整 Trace。

---

## 阶段四：评测体系与回归门禁

### 目标

用数据证明 PRGuard 的审查质量、修复质量和多 Agent 价值。

### 主要任务

- 扩充安全、可靠性、代码质量数据集；
- 增加正常变更和误报样本；
- 增加跨文件上下文样本；
- 增加 Patch 生成和测试样本；
- 自动执行端到端评测：

```text
Diff -> Review -> Finding -> Patch -> Apply -> Test -> Result
```

- 对比单 Agent、多 Agent 和 Verifier Agent；
- 记录 Token、耗时、成本和工具调用；
- 将关键指标接入 CI 回归门禁。

### 核心指标

- Finding Precision / Recall / F1；
- 高危风险召回率；
- Finding 定位准确率；
- Patch Apply Rate；
- Patch Test Pass Rate；
- Rollback Rate；
- 平均耗时、Token 和模型成本；
- 队列处理延迟。

### 验收标准

- 一条命令生成完整评测报告；
- 评测结果可以比较不同 Agent 策略；
- 关键指标下降时 CI 返回失败；
- README 中展示真实评测数据，而不是只展示功能列表。

---

## 阶段五：显式 Agent 编排与人机协同

### 目标

让 Agent 的规划、工具选择、证据判断和人工审批过程可见、可解释、可回放。

### 主要任务

- 增加意图识别和任务规划事件；
- 记录工具选择和证据收集过程；
- 增加 Evidence Verifier Agent；
- 过滤没有可靠证据的 Finding；
- 记录每个 Finding 的来源 Agent 和支持数；
- 增加 Finding 接受、忽略和修复接口；
- 增加人工审批人、时间和原因；
- 按 Finding 选择性生成 Patch；
- 修复完成后自动进行二次审查。

### 目标流程

```text
Intent Classification
  -> Plan
  -> Specialist Agents
  -> Evidence Verifier
  -> Human Approval
  -> Patch Agent
  -> Verification
  -> Re-review
```

### 验收标准

- Trace 能解释 Agent 为什么读取某个文件、选择某个工具；
- 没有证据的高风险 Finding 不能直接进入修复；
- 人工可以接受、忽略或选择性修复 Finding；
- 修复后能够比较修复前后的风险结果。

---

## 阶段六：GitHub PR 完整闭环

### 目标

把当前的 Webhook 自动触发扩展为完整的 GitHub 研发流程集成。

### 主要任务

- 使用 Webhook Delivery ID 幂等去重；
- 增加 GitHub Check Run；
- 增加 PR 汇总评论和行级评论；
- 支持高危风险阻断合并；
- GitHub 端触发人工审批；
- 自动创建修复分支；
- 推送修复提交；
- 触发 CI 验证；
- 更新 PR Check 状态；
- 支持项目级配置和基础 RBAC。

### 验收标准

- 同一个 Webhook Delivery 不会重复创建 Job；
- PR 可以看到结构化审查结果；
- 高危风险能够阻断 Check；
- 人工批准后才允许创建修复分支；
- CI 结果能够回流到 PRGuard。

---

## 阶段七：生产边界与可观测管理台

### 目标

补齐面向多项目部署和运维排障的基础能力。

### 主要任务

- 统一 `requestId / jobId / runId / traceId`；
- MySQL 中持久化可查询 Trace；
- 增加项目、用户和租户边界；
- 增加 RBAC；
- 增加配置校验和数据库迁移；
- 增加队列积压、Worker 状态和成本统计；
- Admin 页面增加 Finding、Trace、Patch 和评测详情；
- 完善健康检查和优雅关闭。

### 验收标准

- 不同项目的数据不能互相访问；
- 管理员可以定位一个 Job 的完整执行链路；
- 队列、Worker、Agent、Patch 和成本状态可观察；
- 服务能够优雅关闭并保留未完成任务。

---

## 阶段八：项目呈现与简历材料

### 目标

让面试官能够快速理解 PRGuard 的真实问题、技术方案和量化效果。

### 主要任务

- 将顶层 README 改为 PRGuard 首页；
- 增加系统架构图和 Agent 编排流程图；
- 增加 Redis Streams 可靠消费说明；
- 增加完整 Demo：

```text
Webhook -> Review -> Finding -> Approval -> Patch -> Test -> Rollback
```

- 展示 Prometheus 指标和 Admin 页面；
- 展示评测报告；
- 展示 Worker 崩溃恢复；
- 展示测试失败自动回滚；
- 编写 Redis Streams 与 RabbitMQ 的技术取舍文档；
- 准备简历项目描述和面试问答。

### 推荐简历表达

> 设计并实现面向 GitHub PR 的风险治理与安全修复 Agent，采用 Security、Reliability、Code Quality 多 Agent 并行审查，通过 Redis Streams Consumer Group + Worker 实现异步任务处理，并补充 Pending 消息接管、任务幂等、失败重试和死信机制；支持证据约束的风险定位、人工审批式 Patch 生成、隔离环境测试验证和失败自动回滚，基于 Precision、Recall、F1、高危风险召回率和 Patch 通过率建立离线及端到端评测体系。

### 最终验收标准

- README 首页可以独立介绍 PRGuard；
- 新环境可以按文档启动项目；
- Demo 能完整跑通；
- 所有核心数据都有可复现命令；
- 能清楚解释 Redis Streams、Agent 编排、Patch 安全和评测设计；
- 项目可以在 3 分钟内完成技术演示，在 10 分钟内完成架构讲解。

---

## 推荐执行顺序

```text
阶段一：Redis Streams 可靠任务系统
阶段二：Agent Runtime 取消、超时与恢复
阶段三：安全 Patch 与测试隔离
阶段四：评测体系与回归门禁
阶段五：显式 Agent 编排与人机协同
阶段六：GitHub PR 完整闭环
阶段七：生产边界与可观测管理台
阶段八：项目呈现与简历材料
```

每个阶段完成后都需要：

1. 增加自动化测试；
2. 更新相关文档；
3. 运行 `npm.cmd run check`；
4. 运行 `npm.cmd test`；
5. 保留一条可复现的 Demo 命令；
6. 提交一个独立、可解释的 Git commit。

## 当前下一步

从阶段一开始，第一批实现任务为：

1. 为 Redis Queue 增加 Pending 消息查询和自动接管；
2. 为 Job 增加幂等状态转换；
3. 增加 Worker 崩溃恢复和重复消息测试；
4. 增加队列积压、接管和死信 Prometheus 指标；
5. 更新 `docs/PRGUARD_JOBS.md` 和 Redis 可靠性说明。
