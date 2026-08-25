# PRGuard 本地 HTTP API

批次二增加了一个本地 HTTP 服务。它复用 `ReviewService` 和 `TraceService`，默认只监听 `127.0.0.1`，适合后续接 Web 页面、Webhook 或任务队列。

启动：

```powershell
npm.cmd run dev -- pr serve --port 8787
```

健康检查：

```http
GET /healthz
```

提交 Review：

```http
POST /api/v1/reviews
Content-Type: application/json

{
  "cwd": "D:/workspace/demo",
  "diffPath": "tmp/change.diff",
  "multiAgent": true
}
```

也可以传入 `baseRef`、`headRef` 或 `diffText`，字段规则与 CLI 的 `pr review` 相同。响应包含 `runId` 和结构化 `review`，Review 过程中的完整事件会写入 Trace。

查询 Trace：

```http
GET /api/v1/traces
GET /api/v1/traces/<run-id>
```

当前 API 只提供 Review 和只读 Trace 查询；Patch 应用仍保留在 CLI 的人工确认流程中，避免远程请求未经确认修改本地代码。
