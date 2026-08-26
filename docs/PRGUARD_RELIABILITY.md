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
PR_GUARD_VERIFICATION_TIMEOUT_MS=120000
```

## Patch verification isolation

Repair verification is performed in a temporary detached Git worktree. The generated patch is applied and tested there first; only a passing verification is applied to the original worktree. Before the final apply, PRGuard checks that the original worktree is still clean, so concurrent local edits are not overwritten. Failed or timed-out verification leaves the original worktree unchanged and the temporary worktree is removed.

Verification commands are restricted to known project runners (`npm`, `pnpm`, `yarn`, `node`, `pytest`, `cargo`, and `go`) and shell metacharacters are rejected. `PR_GUARD_VERIFICATION_TIMEOUT_MS` bounds the test process.

## AbortSignal 与真正取消

Review Job 的取消信号现在会贯穿 Worker、ReviewService、Agent Loop、Model Adapter 和工具执行：

- Review 超时会触发 `AbortController`，底层模型请求会收到终止信号；
- `run_command` 使用同一个信号终止正在运行的子进程；
- Worker 收到 SIGINT/SIGTERM 时，当前任务会标记为 `cancelled`，并重新入队，避免优雅关闭时丢失任务；
- 超时任务标记为 `timed_out`，按照最大尝试次数进入重试或死信流程；
- 完成任务的 Trace 会保留失败阶段和取消原因。

查看死信任务：

```bash
docker compose exec redis redis-cli XINFO STREAM prguard:review-jobs:dead-letter
```

当前超时会将 Job 标记为失败并进入重试流程；后续可以继续把 AbortSignal 贯穿到模型和工具调用，实现真正的执行取消。
