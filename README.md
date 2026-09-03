# PRGuard

面向研发流程的 PR 风险治理与安全修复 Agent。

PRGuard 将 Pull Request 审查从一次性的 LLM 调用，扩展为可恢复、可观测、可验证、可回滚的工程闭环：

```text
GitHub PR -> Webhook HMAC 校验与 Delivery 幂等 -> Review Job
-> Redis Streams Consumer Group -> Worker
-> Security / Reliability / Code Quality Agents
-> Finding 聚合与 Evidence Verifier -> 人工确认
-> Patch Agent -> 临时 Git Worktree 隔离测试
-> 成功应用或失败回滚 -> GitHub Check Run / PR Comment
```

## 项目亮点

- Multi-Agent 深度编排：风险 Router 动态选择 Security、Reliability、Code Quality 专家，通过共享 Blackboard、Critic/Judge 和全局预算完成协作与冲突仲裁。
- 证据驱动的 Finding：风险结论关联变更文件、代码位置和可验证证据。
- Adaptive 路由：低风险 Diff 走 Single-Agent，复杂或高风险 Diff 升级到 Multi-Agent。
- Evidence Verifier：对未充分支持或低置信度 Finding 做选择性证据复核。
- Redis Streams 可靠任务系统：Consumer Group、ACK、Heartbeat、XAUTOCLAIM、重试、死信和 Worker 崩溃恢复。
- 安全修复闭环：人工审批、补丁生成、临时 Worktree 测试、失败自动回滚。
- 双层执行隔离：Git Worktree 隔离文件变更，Docker 沙箱禁网、只读根文件系统、降权并限制 CPU、内存和进程数。
- GitHub 集成：Webhook 自动触发、PR Diff 拉取、Check Run 和结构化评论。
- 可观测性：Run Trace、API/Worker 独立 Prometheus `/metrics`、模型 Token、工具调用、耗时和失败原因。
- 可恢复 Agent Runtime：依赖 DAG Planner、步骤状态机、消息快照、持久化工具执行账本和 `/continue-run` 断点续跑。
- Specialist 级恢复：Multi-Agent 审查按输入和长期记忆版本缓存已完成专家，只重跑失败或未完成的专家。
- Memory 2.0：短期工作记忆与长期情景/语义/反馈记忆分层，支持混合检索、去重重排、冲突消解、结果强化、语义归纳、容量治理和来源追踪。
- 持久化：MySQL 保存 Review Job、Finding、Patch 和 Trace；PostgreSQL + pgvector 保存长期记忆；未配置数据库时支持本地文件降级。

## 评测结果

项目包含 57 条人工标注 PR Diff，划分为 37 条 validation 和 20 条 holdout，覆盖 Security、Reliability、Code Quality、多风险样本、安全负样本和 5 个修复任务。

最终 Holdout 对照实验（模型：`gpt-5.5`，Prompt：`prguard-review-v1`）：

| 模式 | Finding F1 | 高风险召回率 | 任务失败率 |
|---|---:|---:|---:|
| Rule Baseline | 57.1% | 57.1% | 0.0% |
| Single-Agent | 71.4% | 100.0% | 0.0% |
| Multi-Agent | **76.5%** | **100.0%** | 0.0% |
| Multi-Agent + Verifier | 68.6% | 85.7% | 0.0% |
| Adaptive | 66.7% | 100.0% | 0.0% |

Multi-Agent 在 Holdout 上相比 Single-Agent 提升 5.1 个百分点，相比规则基线提升 19.4 个百分点。当前默认模式为 Multi-Agent；Single-Agent 适合低成本场景，Adaptive 和 Verifier 作为成本优化与证据复核策略保留。

> 评测结果保存在 `evals/reports/`，每次运行同时生成 `manifest.json`、`predictions.jsonl`、`report.json` 和独立 Run Trace。

## 技术栈

TypeScript / Node.js / Redis Streams / MySQL / PostgreSQL / pgvector / Embedding API / GitHub API / Prometheus / Docker Compose

## 快速开始

### 1. 安装依赖

```powershell
npm install
```

### 2. 启动 MySQL 和 Redis，并准备 PostgreSQL Memory

```powershell
docker compose up -d
```

MySQL 和 Redis 由 Compose 启动。PostgreSQL + pgvector 在 WSL Ubuntu 中运行时，需先完成一次初始化：

```bash
sudo service postgresql start
sudo -u postgres psql -d postgres -c "CREATE EXTENSION IF NOT EXISTS vector;"
sudo -u postgres psql -c "CREATE USER prguard WITH PASSWORD 'prguard_dev_password';"
sudo -u postgres createdb -O prguard prguard
sudo -u postgres psql -d prguard -f /mnt/d/AI_agent/MiniCode/infra/postgres/init/002_memory.sql
```

然后在 `.env` 中配置 `PR_GUARD_MEMORY_BACKEND=postgres`、PostgreSQL URL 和 Embedding API。没有远程 Embedding 配置时，可将 Provider 切换为 `hash`，用于离线测试。

### 3. 配置模型

复制 `.env.example` 为 `.env`，配置 `ANTHROPIC_MODEL`、`ANTHROPIC_BASE_URL` 以及 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`。不要将 `.env` 提交到 Git。

### 4. 运行本地审查

```powershell
npm.cmd run dev -- pr review --base HEAD~1 --multi-agent --json
```

### 5. 启动 API 与 Worker

```powershell
npm.cmd run dev -- pr serve --port 8787
npm.cmd run dev -- pr worker
```

API 默认监听 `http://127.0.0.1:8787`，Worker 的 Prometheus 指标默认监听 `http://127.0.0.1:9091/metrics`。

## 评测命令

规则基线不需要模型 API；Agent 模式会读取 `.env` 中的模型配置。

```powershell
npm.cmd run dev -- pr eval-run --mode rule-baseline --split holdout --output evals/reports/rule-holdout
npm.cmd run dev -- pr eval-run --mode single-agent --split holdout --output evals/reports/single-holdout
npm.cmd run dev -- pr eval-run --mode multi-agent --split holdout --output evals/reports/multi-holdout
npm.cmd run dev -- pr eval-run --mode multi-agent-verifier --split holdout --output evals/reports/verifier-holdout
npm.cmd run dev -- pr eval-run --mode adaptive --split holdout --output evals/reports/adaptive-holdout
```

## Demo

建议按照 [PRGuard Demo Runbook](./docs/PRGUARD_DEMO_RUNBOOK.md) 演示完整的“审查—人工确认—修复—测试—回滚”流程。

## 文档

- [系统架构](./docs/PRGUARD_ARCHITECTURE.md)
- [本地 Demo Runbook](./docs/PRGUARD_DEMO_RUNBOOK.md)
- [HTTP API](./docs/PRGUARD_API.md)
- [GitHub Webhook 集成](./docs/PRGUARD_GITHUB.md)
- [Redis Streams 与 Worker](./docs/PRGUARD_JOBS.md)
- [Multi-Agent 设计](./docs/PRGUARD_MULTI_AGENT.md)
- [评测方法与指标](./docs/PRGUARD_EVAL.md)
- [评测失败分析](./docs/PRGUARD_V1_FAILURE_ANALYSIS.md)
- [可观测性](./docs/PRGUARD_OBSERVABILITY.md)
- [安全边界](./docs/PRGUARD_SECURITY.md)
- [修复可靠性](./docs/PRGUARD_RELIABILITY.md)
- [验证命令沙箱](./docs/PRGUARD_SANDBOX.md)
- [Agent Runtime 与断点恢复](./docs/AGENT_RUNTIME_RECOVERY.md)
- [Memory 2.0](./docs/PRGUARD_MEMORY.md)
- [数据持久化](./docs/PRGUARD_STORAGE.md)
- [简历项目描述](./docs/PRGUARD_RESUME.md)

## 测试

```powershell
npm.cmd run check
npm.cmd test
```

当前自动化测试结果：367 passed，0 failed，1 skipped（默认不连接外部 Redis/PostgreSQL；CI 会启用对应集成测试）。

## License

MIT
