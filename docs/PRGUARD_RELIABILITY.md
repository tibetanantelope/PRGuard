# PRGuard 可靠 Agent Runtime

阶段六为 Review Job 增加了基础可靠性机制：

- `attempts` / `maxAttempts`：记录尝试次数并限制自动重试；
- 超时：由 `PR_GUARD_REVIEW_TIMEOUT_MS` 控制，默认 120 秒；
- 租约：claim 写入 `lease_owner`、`lease_expires_at` 和递增的 `fencing_token`；
- 心跳：只有当前 owner 和 fencing token 能续租，旧 Worker 无法回写；
- 状态机：统一约束 queued、running 和终态之间的迁移；
- Outbox：Job 先持久化调度事件，再以幂等键发布到 Redis；
- 对账：Worker 扫描 queued Job，自动修复数据库已有任务但队列消息缺失的情况；
- 重试：使用 1s、2s、4s……最高 60s 的指数退避；
- 死信队列：达到最大次数后幂等写入 `<stream>:dead-letter`，支持 list 和 redrive；
- 外部副作用：GitHub Check Run 使用 `external_id`，评论使用唯一 marker，重复发布转为更新；
- MySQL 自动升级：启动时补充 lease、fencing 和 Outbox 结构。

Agent 内部执行的断点、计划恢复和工具副作用语义见 [Agent Runtime 与断点恢复](./AGENT_RUNTIME_RECOVERY.md)。Job 租约解决 Worker 归属问题；Runtime Checkpoint 解决同一个 Job 内模型、工具和 Specialist 的细粒度恢复问题，两层机制不能互相替代。

配置示例：

```dotenv
PR_GUARD_MAX_ATTEMPTS=3
PR_GUARD_REVIEW_TIMEOUT_MS=120000
PR_GUARD_VERIFICATION_TIMEOUT_MS=120000
```

## Patch verification isolation

Repair verification uses two isolation layers. A temporary detached Git worktree protects the original checkout, while production verification runs inside a locked-down Docker container. The generated patch is applied and tested in the temporary worktree first; only a passing verification is applied to the original worktree. Before the final apply, PRGuard checks that the original worktree is still clean, so concurrent local edits are not overwritten. Failed or timed-out verification leaves the original worktree unchanged and the temporary worktree is removed.

Verification commands are restricted to known project runners (`npm`, `pnpm`, `yarn`, `node`, `pytest`, `cargo`, and `go`) and shell metacharacters are rejected. Docker mode disables networking, drops Linux capabilities, enables `no-new-privileges`, uses a read-only root filesystem and limits CPU, memory, PIDs, output size and duration. Docker startup failure is fail-closed and never falls back to host execution. See [验证命令沙箱](./PRGUARD_SANDBOX.md).

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

也可以通过管理接口重投：

```text
GET  /api/v1/dead-letters
POST /api/v1/dead-letters/<dead-letter-id>/redrive
```
