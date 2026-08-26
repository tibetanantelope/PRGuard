# GitHub PR 集成

阶段十提供两种入口：CLI 拉取 PR Diff，以及 Webhook 自动创建异步 Review Job。

## CLI

```powershell
$env:GITHUB_TOKEN = 'ghp_***'
npm.cmd run dev -- pr review --github owner/repository#123 --multi-agent
```

Token 只用于读取 GitHub PR Diff，不会自动修改仓库或发表评论。

## Webhook

在 `.env` 中配置：

```dotenv
GITHUB_TOKEN=ghp_***
PR_GUARD_GITHUB_WEBHOOK_SECRET=local-shared-secret
PR_GUARD_GITHUB_WORKSPACE=D:\AI_agent\MiniCode
```

把 GitHub Webhook 指向：

```text
POST /api/v1/github/webhook
```

只处理 `pull_request` 的 `opened`、`reopened` 和 `synchronize` 事件。请求必须带有 GitHub 的 `x-hub-signature-256`，签名校验失败会返回 `401`。合法事件只会拉取 Diff 并创建 Review Job，实际分析仍由 Worker 执行。

默认不自动回写 Review Comment，也不自动合并或修改代码；审查、修复和人工确认保持明确分开。需要 GitHub 反馈时可以显式开启下方的安全配置。

## Webhook 幂等与 GitHub 反馈

Webhook 会读取 `X-GitHub-Delivery`，并将已经处理过的 Delivery ID 持久化到 `.mini-code/prguard/github-deliveries.json`，重复投递只返回 `duplicate: true`，不会重复创建 Review Job。

如需在 Review Job 完成后创建 GitHub Check Run 并发布 PR 评论，显式开启：

```dotenv
PR_GUARD_GITHUB_FEEDBACK_ENABLED=true
GITHUB_TOKEN=***
```

Webhook 需要包含 Pull Request head SHA；反馈失败只记录到 Run Trace，不会把已经完成的审查重新判定为失败。
