# PRGuard 可观测性

阶段八提供两类运行观测能力：JSON 结构化日志和 Prometheus 指标。

## 指标端点

启动 API 后访问：

```text
GET http://127.0.0.1:8787/metrics
```

当前包含：

- `prguard_http_requests_total`：HTTP 请求数量，按方法、路由和状态码统计。
- `prguard_http_request_duration_ms`：HTTP 请求耗时。
- `prguard_jobs_total`：完成的异步任务数量。
- `prguard_job_duration_ms`：Job 总耗时。
- `prguard_model_requests_total`：模型响应数量。
- `prguard_model_tokens_total`：模型输入/输出 Token 数量。
- `prguard_model_request_duration_ms`：模型请求耗时。
- `prguard_tool_calls_total`：工具调用数量及成功/失败状态。
- `prguard_tool_duration_ms`：工具调用耗时。

指标是进程内聚合数据，API 或 Worker 重启后会清零。生产环境可以让 Prometheus 定时抓取 API 的 `/metrics`，并将 Worker 的指标通过独立 metrics exporter 暴露；当前版本优先保证单机开发和面试演示链路完整。

## 结构化日志

审查完成会输出一行 JSON，例如：

```json
{"timestamp":"...","service":"prguard","event":"review_completed","runId":"...","findingCount":2,"multiAgent":true}
```

日志不记录 API Key、完整 Diff 或模型原始响应，避免把敏感数据直接写入服务日志。
