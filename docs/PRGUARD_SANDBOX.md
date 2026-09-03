# PRGuard 验证命令沙箱

临时 Git Worktree 只能保证测试失败时不污染原工作区，不能阻止不可信测试代码访问宿主网络、环境变量或消耗系统资源。PRGuard 因此将 Patch 验证拆成文件隔离与进程隔离两层。

## 生产模式

`PR_GUARD_SANDBOX_MODE=docker` 是服务层默认值。验证容器具备以下限制：

- `--network none`：禁止容器网络；
- `--read-only`：容器根文件系统只读；
- `--cap-drop ALL` 与 `no-new-privileges`；
- 非 root 用户执行；
- CPU、内存和 PID 数量限制；
- `/tmp` 使用限制大小且带 `noexec,nosuid` 的 tmpfs；
- 仅将临时验证 Worktree 挂载到 `/workspace`；
- 模型服务、GitHub、数据库等宿主凭证不会注入容器；
- 超时后强制删除命名容器；
- Docker 不存在、镜像不可用或容器启动失败时直接判定验证失败，不回退到宿主执行。
- `/readyz` 会检查 Docker daemon；沙箱不可用时返回 `503 not_ready`，部署系统可据此停止分配流量。

配置示例：

```dotenv
PR_GUARD_SANDBOX_MODE=docker
PR_GUARD_SANDBOX_IMAGE=node:22-alpine
PR_GUARD_SANDBOX_MEMORY_MB=512
PR_GUARD_SANDBOX_CPUS=1
PR_GUARD_SANDBOX_PIDS_LIMIT=128
PR_GUARD_SANDBOX_MAX_OUTPUT_BYTES=1048576
PR_GUARD_VERIFICATION_TIMEOUT_MS=120000
```

沙箱镜像由部署方固定配置，不接受模型或 API 请求动态指定。不同技术栈可部署使用相应工具链的内部固定镜像。

## 本地兼容模式

`PR_GUARD_SANDBOX_MODE=local` 仅适合可信代码、本地开发和测试。它仍执行命令白名单、Shell 元字符拒绝、超时、输出上限和敏感环境变量清洗，但不是进程级安全边界，不能用于执行来自不可信 PR 的代码。

## Patch 输入门禁

在创建 Worktree 和启动容器前，PRGuard 会拒绝：

- 超过 `PR_GUARD_PATCH_MAX_BYTES` 的 Patch；
- 修改文件数超过 `PR_GUARD_PATCH_MAX_FILES` 的 Patch；
- 绝对路径、路径穿越和 `.git` 元数据路径；
- Binary Patch；
- 符号链接和 Git submodule 模式变更。

这些检查不能替代容器隔离。其作用是缩小输入面、限制资源消耗并阻止 Git 元数据类攻击。
