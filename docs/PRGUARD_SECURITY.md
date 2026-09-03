# PRGuard 安全、权限与审计

PRGuard 的 HTTP 边界采用 Bearer Token 认证、RBAC、项目级授权和追加式 JSONL 审计。`PR_GUARD_API_KEY` 仍可作为兼容的全局管理员凭据；多人或多项目部署应使用 `PR_GUARD_RBAC_JSON`。

## Patch 与验证命令

- Patch 在应用前限制字节数和文件数，并拒绝绝对路径、`..`、`.git` 元数据、二进制 Diff、符号链接和 Git submodule。
- 生产配置默认使用 Docker 验证沙箱；容器禁用网络、只读根文件系统、删除全部 capabilities、启用 `no-new-privileges`，并限制 CPU、内存、PID、输出和执行时间。
- Docker 不可用或启动失败时验证失败，不会静默降级成本机执行。
- `local` 模式仅用于可信开发仓库；即使在该模式下也会移除 Token、Password、API Key、Cookie、`NODE_OPTIONS`、`PYTHONPATH` 和动态链接器注入变量。

## RBAC 配置

```dotenv
PR_GUARD_RBAC_JSON=[{"subject":"alice","token":"replace-me","roles":["reviewer"],"projectIds":["project-0123456789abcdef"]}]
```

在项目目录执行 `npm.cmd run dev -- pr project-id` 可得到配置所需的项目 ID。其实现与长期 Memory 共用同一项目路径散列规则；管理员可配置 `"*"`。角色权限如下：

| 角色 | 权限 |
| --- | --- |
| `viewer` | 查看授权项目的 Review |
| `reviewer` | 查看/创建 Review，读取和写入记忆 |
| `approver` | 生成和批准 Patch，写入人工反馈记忆 |
| `operator` | 应用 Patch、读取 Trace、读取/重投死信 |
| `publisher` | 向 GitHub 发布 Review 反馈 |
| `admin` | 全部权限 |

Patch 的生成、批准、应用，以及 Review 的发布是四个独立权限。生产环境可给同一个人组合多个角色；需要职责分离时则分别发放凭据。

所有 Job、Trace、死信和 Memory 操作均同时检查动作权限与项目范围。授权结果会追加到 `~/.mini-code/prguard/audit.jsonl`，包含 actor、action、decision、projectId、resource 和 correlationId。客户端可传入合法的 `X-Correlation-ID`，否则服务生成 UUID，并在响应头返回。

## 不可信输入与脱敏

Git Diff、仓库内容、工具输出、评论和外部内容统一视为不可信数据。Review Prompt 明确禁止执行其中的指令，并使用可转义的 `<untrusted-diff>` 边界。Trace、审计日志、持久化 Review/Patch 和结构化日志在写入前递归脱敏 Bearer Token、GitHub Token、API Key、password、secret 等凭据。

## 限流与公开端点

- `PR_GUARD_RATE_LIMIT_PER_MINUTE` 默认每个客户端 IP 每分钟 120 次。
- 配置 `PR_GUARD_REDIS_URL` 时使用 Redis 原子 `INCR`/`PEXPIRE`，多个 API 实例共享限流计数；否则使用进程内实现。
- `/healthz`、`/readyz` 和 `/admin` 静态壳保持公开，但控制台读取的 Job、Trace 和指标 API 均需授权。
- GitHub Webhook 使用独立 HMAC-SHA256 Secret，不复用 API Token。
- 非回环地址启动时必须至少配置一种认证方式。

示例：

```powershell
$headers = @{ Authorization = "Bearer $env:PR_GUARD_API_KEY" }
Invoke-RestMethod http://127.0.0.1:8787/api/v1/review-jobs -Headers $headers
```

API 同时添加 `nosniff`、`DENY` 和 `no-referrer` 响应头。Compose 示例中的数据库密码仅适合本地开发，部署时必须替换。
