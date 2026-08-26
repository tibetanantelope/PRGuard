# PRGuard 后续开发路线

> 本文件保留为历史阶段记录。当前实际执行计划请查看 [PRGUARD_DEVELOPMENT_PLAN.md](./PRGUARD_DEVELOPMENT_PLAN.md)，其中已将 Redis Streams 可靠消费、幂等、Worker 恢复和死信处理提升为第一阶段。

> Current progress: Stages 1–12 completed. Stage 7 added MySQL business persistence; Stage 8 added structured logs and Prometheus metrics; Stage 9 added baseline comparison and evaluation regression checks; Stage 10 added GitHub PR input and signed webhook job intake; Stage 11 added API authentication, rate limiting, audit-safe logs, and graceful shutdown controls; Stage 12 added the lightweight Web Admin Console.

PRGuard 当前已经完成阶段一至阶段五：Service 层、HTTP API、异步 Job、MySQL 持久化，以及 Redis Streams + Worker。

## 阶段一：核心 Service 层

- 提取 Review、Repair、Trace、Evaluation Service；
- CLI 通过 Service 调用；
- 为后续 HTTP API、Worker 和测试复用业务逻辑。

## 阶段二：HTTP API

- 提供健康检查；
- 提交同步 Review；
- 查询 Trace；
- 为 Web 页面和 GitHub Webhook 预留入口。

## 阶段三：异步 Review Job

- 创建和查询 Review Job；
- 管理 queued、running、completed、failed 状态；
- 通过后台 Worker 执行模型分析。

## 阶段四：MySQL 持久化

- 使用 MySQL 保存 Job、Review、Finding、Patch 和 Trace 数据；
- 抽象 Repository；
- 使用 Docker Compose 管理本地数据库环境。

## 阶段五：Redis Streams + Worker

- 使用 Redis Stream 作为任务队列；
- 使用 Consumer Group 消费任务；
- API Server 和 Review Worker 解耦；
- 支持独立扩展 Worker。

## 阶段六：可靠 Agent Runtime

- Job 超时控制；
- Worker 心跳；
- 失败自动重试；
- 最大重试次数；
- Redis 死信队列；
- Job 幂等执行；
- Job 取消；
- Checkpoint / Resume；
- Token 和成本预算。

## 阶段七：完整业务数据持久化

- 将 Review 写入 `reviews`；
- 将 Finding 写入 `findings`；
- 将 Patch 写入 `patches`；
- 将 Verification 写入验证记录；
- 将 Trace 事件写入 `trace_events`；
- 支持项目历史 Review 和风险统计查询。

## 阶段八：可观测性和运行监控

- Worker 结构化日志；
- Job 开始、完成、失败日志；
- Agent 和 Tool 调用耗时；
- Token 和模型成本统计；
- Prometheus 指标；
- Trace 查询和运行大盘。

## 阶段九：Agent 评测体系

- 扩充安全、可靠性、代码质量数据集；
- 对比单 Agent 和多 Agent；
- 统计 Precision、Recall、F1；
- 统计高风险问题召回率；
- 统计 Patch 验证通过率；
- 建立模型升级回归评测。

## 阶段十：GitHub PR 集成

- 拉取 GitHub PR Diff；
- 接收 PR Webhook；
- 自动创建 Review Job；
- 回写 Review Comment；
- 用户确认后生成修复分支或 Patch。

## 阶段十一：安全和生产化

- API 鉴权；
- 用户、项目和租户隔离；
- RBAC 权限；
- API 限流；
- 敏感信息脱敏；
- 审批记录；
- 健康检查和优雅关闭；
- 数据库迁移和生产配置分离。

## 阶段十二：可选 Web 管理台

- Review Job 列表；
- Finding 详情；
- Trace 时间线；
- Patch Diff 展示；
- Worker 状态；
- Agent 成本统计；
- 评测报告展示。

## 推荐优先级

```text
阶段六：可靠 Agent Runtime
阶段七：完整业务数据持久化
阶段八：可观测性
阶段九：评测体系
阶段十：GitHub 集成
阶段十一：生产化
阶段十二：Web 管理台（可选）
```
