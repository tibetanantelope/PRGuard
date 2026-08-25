# PRGuard 阶段六：可靠 Agent Runtime

阶段六为 Review Job 增加了基础可靠性机制：

- `attempts` / `maxAttempts`：记录尝试次数并限制自动重试；
- 超时：由 `PR_GUARD_REVIEW_TIMEOUT_MS` 控制，默认 120 秒；
- 心跳：执行期间持续更新 Job 的 `updated_at`；
- 幂等：已完成的 Job 被重复消费时不会再次执行；
- 重试：失败且未达到最大次数时重新放回 Redis Stream；
- 死信队列：达到最大次数后写入 `<stream>:dead-letter`；
- MySQL 自动升级：启动时为已有 `review_jobs` 表补充重试字段。

配置示例：

```dotenv
PR_GUARD_MAX_ATTEMPTS=3
PR_GUARD_REVIEW_TIMEOUT_MS=120000
```

查看死信任务：

```bash
docker compose exec redis redis-cli XINFO STREAM prguard:review-jobs:dead-letter
```

当前超时会将 Job 标记为失败并进入重试流程；后续可以继续把 AbortSignal 贯穿到模型和工具调用，实现真正的执行取消。
