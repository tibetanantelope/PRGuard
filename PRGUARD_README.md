# PRGuard

面向研发流程的 PR 风险治理与安全修复 Agent。

PRGuard 是一条可恢复、可观测、可验证的研发流水线：

```text
GitHub PR -> Webhook 幂等 -> Review Job -> Redis Streams -> Worker
-> Multi-Agent Review -> Evidence Verifier -> Human Approval
-> Patch Agent -> Temporary Git Worktree -> Test/Rollback
-> GitHub Check Run and Comment
```

## 主要能力

- Security / Reliability / Code Quality 多 Agent PR 审查
- Finding 聚合、证据验收和人工确认
- MySQL 持久化 Review、Finding、Patch、Trace
- Redis Streams Pending 恢复、重试、Heartbeat 和死信
- Agent Runtime 超时、取消和 Worker 崩溃恢复
- 临时 Git worktree 补丁验证，失败自动回滚
- GitHub Webhook、Delivery 幂等、Check Run 和 PR 评论
- CLI、HTTP API、Admin Console 和 Prometheus 指标
- 离线评测、规则基线和回归门禁

## 快速运行

```powershell
npm install
Copy-Item .env.example .env
docker compose up -d
npm.cmd run check
npm.cmd test
```

启动 API 和 Worker：

```powershell
npm.cmd run dev -- pr serve --port 8787
npm.cmd run dev -- pr worker
```

- Admin：`http://127.0.0.1:8787/admin`
- Readiness：`http://127.0.0.1:8787/readyz`
- Worker Metrics：`http://127.0.0.1:9091/metrics`

完整演示见 [Demo Runbook](./docs/PRGUARD_DEMO_RUNBOOK.md)。

## 评测

```powershell
npm.cmd run dev -- pr eval --baseline
npm.cmd run dev -- pr eval --predictions model-predictions.jsonl --gate --min-f1 0.70 --min-high-risk-recall 0.90 --json
```

## 文档

- [架构说明](./docs/PRGUARD_ARCHITECTURE.md)
- [Demo Runbook](./docs/PRGUARD_DEMO_RUNBOOK.md)
- [GitHub 集成](./docs/PRGUARD_GITHUB.md)
- [可靠性设计](./docs/PRGUARD_RELIABILITY.md)
- [安全与生产边界](./docs/PRGUARD_SECURITY.md)
- [评测与回归门禁](./docs/PRGUARD_EVAL.md)
- [简历项目描述](./docs/PRGUARD_RESUME.md)
