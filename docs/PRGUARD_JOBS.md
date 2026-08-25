# PRGuard 异步 Review Job

阶段五将 Review Job 放入 Redis Stream：API 请求进入队列后立即返回 `jobId`，独立 Worker 消费任务并执行 Review，状态持久化到 MySQL。

启动 API 和 Worker：

```powershell
npm.cmd run dev -- pr serve --port 8787
npm.cmd run dev -- pr worker
```

两条命令需要在不同终端运行。Worker 使用 Redis Consumer Group 消费 `prguard:review-jobs`，默认组名为 `prguard-workers`。

创建任务：

```http
POST /api/v1/review-jobs
Content-Type: application/json

{
  "cwd": "D:/workspace/demo",
  "diffPath": "tmp/change.diff",
  "multiAgent": true
}
```

成功时返回 HTTP `202`：

```json
{
  "jobId": "...",
  "status": "queued",
  "multiAgent": true,
  "createdAt": "...",
  "updatedAt": "...",
  "cwd": "D:/workspace/demo"
}
```

查询任务：

```http
GET /api/v1/review-jobs/<job-id>
GET /api/v1/review-jobs

## 人工协同修复

审查任务完成后，可以由人工显式触发补丁生成：

```powershell
$body = @{ findingIds = @('finding-1'); apply = $false } | ConvertTo-Json
Invoke-RestMethod `
  -Uri 'http://127.0.0.1:8787/api/v1/review-jobs/<job-id>/repair' `
  -Method Post -ContentType 'application/json' -Body $body
```

默认只生成补丁，不修改工作区。确认补丁后，如需在当前工作区应用并运行测试，必须显式传入 `apply: true` 和测试命令：

```powershell
$body = @{
  findingIds = @('finding-1')
  apply = $true
  testCommand = 'npm.cmd test'
} | ConvertTo-Json
Invoke-RestMethod `
  -Uri 'http://127.0.0.1:8787/api/v1/review-jobs/<job-id>/repair' `
  -Method Post -ContentType 'application/json' -Body $body
```

应用前会检查工作区是否干净，补丁校验或测试失败会自动回滚。这个接口不会自动切换 Git 分支、提交或推送；使用 GitHub Webhook 时，应先在本地准备好对应 PR 的代码分支，再人工确认应用。
```

任务完成后会包含 `runId` 和结构化 `result`；失败时会包含 `error`。完整模型调用、工具调用和 Review 结果仍然通过 Trace 保存。

当前 Worker 使用单并发，目的是先保证本地资源和模型成本可控。Redis 消息确认在 Review 执行完成后进行，执行失败的 Job 会保留 `failed` 状态，后续阶段再增加自动重试和死信队列。
