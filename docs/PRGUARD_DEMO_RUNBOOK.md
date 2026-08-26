# PRGuard Demo Runbook

目标：在 3～5 分钟内展示一次真实的“审查—确认—修复—测试”流程。

## 1. 启动基础设施

```powershell
docker compose up -d
```

## 2. 启动 API 和 Worker

终端一：

```powershell
npm.cmd run dev -- pr serve --port 8787
```

终端二：

```powershell
npm.cmd run dev -- pr worker
```

## 3. 发起多 Agent 审查

```powershell
npm.cmd run dev -- pr review --diff evals/fixtures/command-injection.diff --multi-agent --json
```

重点展示：专家 Agent、Evidence Verifier、人工确认和 Run Trace。

## 4. 查看 Admin 和指标

打开 `http://127.0.0.1:8787/admin`。

```powershell
(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8787/readyz').Content
(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:9091/metrics').Content | Select-String 'prguard_queue'
```

## 5. 展示安全修复

```powershell
npm.cmd run dev -- pr repair --base HEAD~1 --finding finding-1 --test-command "npm.cmd test"
```

补丁先在临时 worktree 中验证；失败时原工作区不变并自动清理，成功后才应用。

## 6. 展示评测门禁

```powershell
npm.cmd run dev -- pr eval --baseline
```

## 推荐讲解顺序

1. 真实问题：PR 风险需要稳定审查和安全修复。
2. Agent 能力：多角色分析、工具调用、证据验收、人工确认。
3. 工程化：Redis Streams、Worker、MySQL、Trace、超时恢复。
4. 安全边界：worktree 隔离、命令白名单、回滚、API 鉴权。
5. 结果指标：F1、高风险召回率、Patch 测试通过率。
