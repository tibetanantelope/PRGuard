# PRGuard 异步 Review Job

## Redis Streams 可靠消费

### 自动化集成验证

不需要启动 PRGuard API 或 Review Worker。启动 Docker Redis 后，在 WSL Bash 中执行：

```bash
export PRGUARD_REDIS_INTEGRATION=1; export PR_GUARD_REDIS_URL=redis://127.0.0.1:6380; npm.cmd run test:redis
```

测试会自动创建临时 Stream 和 Consumer Group，模拟第一个消费者拿到消息后退出，等待租约过期，再由第二个消费者执行 `XAUTOCLAIM` 并 ACK，最后检查 Pending 数量是否为 `0`，测试结束后自动删除临时 Stream。

Worker 使用 Consumer Group 消费 `prguard:review-jobs`。任务被读取后会进入 Pending Entries，只有 Review 成功、失败处理完成或进入死信后才 ACK。

当 Worker 在执行期间退出时，另一个 Worker 会使用 `XAUTOCLAIM` 接管超过空闲阈值的 Pending 消息。执行中的 Worker 会定期使用 `XCLAIM` 续期消息租约，避免长时间 Review 被误判为失联任务。

默认配置：

```dotenv
PR_GUARD_REDIS_RECLAIM_IDLE_MS=30000
```

Job Repository 会在执行前原子抢占 `queued` 状态的 Job。重复投递不会重复执行已完成或正在运行的 Job。临时失败按最大尝试次数重试，超过次数后写入 `prguard:review-jobs:dead-letter`。

独立 Worker 会在 `PR_GUARD_WORKER_METRICS_PORT`（默认 `9091`）暴露自己的 Prometheus 端点：

```text
http://127.0.0.1:9091/metrics
```

API 的 `/metrics` 只包含 API 进程指标；Worker 的消费、接管、ACK、死信、模型和工具指标应从 Worker 的端点读取。

相关指标包括：

- `prguard_queue_reclaimed_total`：Pending 消息接管次数；
- `prguard_queue_pending_jobs`：当前 Pending 消息数量；
- `prguard_queue_dead_letter_total`：进入死信的任务数量；
- `prguard_queue_acked_total`：确认完成的消息数量。

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
