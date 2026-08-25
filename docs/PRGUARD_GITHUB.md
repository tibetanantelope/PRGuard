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

当前阶段不自动回写 Review Comment，也不自动合并或修改代码；这样可以把审查、修复和人工确认明确分开，下一阶段再补生产安全和权限控制。
