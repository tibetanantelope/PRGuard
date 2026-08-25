# PRGuard 安全与生产化

阶段十一提供基础生产安全能力：

- 配置 `PR_GUARD_API_KEY` 后，内部 API、任务查询、Trace 和 `/metrics` 需要 `Authorization: Bearer <key>`。
- `/healthz` 保持公开，GitHub Webhook 使用独立的 HMAC-SHA256 Secret，不复用 API Key。
- `PR_GUARD_RATE_LIMIT_PER_MINUTE` 提供单进程、按客户端 IP 的固定窗口限流，默认每分钟 120 次。
- 认证失败和限流事件会写入结构化审计日志，日志字段名包含 token、secret、password、authorization、api-key 时自动脱敏。
- API 关闭时会停止本地 Worker，并关闭 Redis 队列连接；长时间运行建议使用进程管理器自动拉起。

示例：

```powershell
$headers = @{ Authorization = "Bearer $env:PR_GUARD_API_KEY" }
Invoke-RestMethod http://127.0.0.1:8787/api/v1/review-jobs -Headers $headers
```

当前限流是单实例内存实现，适合本地和单机演示；多副本生产环境应迁移到 Redis 计数器或网关层，并进一步加入用户、项目和 RBAC 数据模型。
