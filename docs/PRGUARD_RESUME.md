# PRGuard 简历项目描述

## 一句话介绍

PRGuard 是一个面向研发流程的 PR 风险治理与安全修复 Agent，能够从 GitHub Webhook 接收 PR，经过 Redis Streams 异步调度和多 Agent 审查，完成证据验收、人工确认、补丁生成、隔离测试和结果回写。

## 简历版本

**PRGuard｜面向研发流程的 PR 风险治理与安全修复 Agent**  
TypeScript / Node.js / Redis Streams / MySQL / GitHub API / Prometheus

- 设计 API + Worker 异步架构，通过 Redis Streams Consumer Group、XAUTOCLAIM、Heartbeat、重试和 Dead Letter 实现任务恢复，避免 Worker 崩溃导致任务丢失或重复执行。
- 构建 Security、Reliability、Code Quality 多 Agent 审查流程，引入 Finding 聚合和 Evidence Verifier，拒绝无变更依据或无效证据的风险结论。
- 实现 Agent Runtime 的 AbortSignal 取消、模型请求超时、工具子进程终止和任务状态分类，支持 `failed`、`timed_out`、`cancelled` 独立处理。
- 实现人工确认式安全修复：Agent 生成 unified patch，在临时 Git worktree 中应用并执行白名单测试命令，失败自动回滚，成功后才写入真实工作区。
- 集成 GitHub PR Webhook HMAC 校验、Delivery 幂等、PR Diff 拉取、Check Run 和结构化评论；通过 MySQL 保存 Job、Finding、Patch 和 Run Trace，并暴露 API/Worker Prometheus 指标。
- 建立包含 57 条人工标注 PR Diff 的离线评测集，划分 37 条 validation 和 20 条 holdout；在 Holdout 上 Multi-Agent 取得 76.5% Finding F1 和 100% 高风险召回率，相比 Single-Agent 的 71.4% F1 提升 5.1 个百分点，相比规则基线提升 19.4 个百分点。
- 建立回归门禁，统一记录 Finding Precision/Recall/F1、高风险召回率、误报/漏报、Token、工具调用、耗时和任务失败率，并保存每个任务的 Run Trace。

## 推荐简历表述

构建面向研发流程的 PR 风险治理与安全修复 Agent，设计 Security/Reliability/Code Quality 多 Agent 并行审查、Finding 聚合、Evidence Verifier 和人工确认式 Patch 修复闭环；基于 Redis Streams Consumer Group、XAUTOCLAIM、Heartbeat、重试与 Dead Letter 实现可恢复异步任务，使用临时 Git Worktree 完成补丁隔离测试与失败回滚。建立 57 条人工标注 PR Diff 的 validation/holdout 评测集，Multi-Agent 在 Holdout 上达到 76.5% Finding F1 和 100% 高风险召回率，相比 Single-Agent 提升 5.1 个百分点。

## 面试关键词

Redis Streams 可靠消费、XAUTOCLAIM、幂等、Agent Runtime、Evidence Verification、Human-in-the-loop、Git Worktree 隔离、Patch Rollback、GitHub Webhook、Prometheus、评测门禁。
