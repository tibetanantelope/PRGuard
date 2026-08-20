# PRGuard 完整 Demo

## 1. 本地 Diff 预览

```powershell
npm.cmd run dev -- pr review --base HEAD~1 --preview
```

## 2. 单 Agent 评审

```powershell
npm.cmd run dev -- pr review --base HEAD~1 --json
```

## 3. 多 Agent 评审

```powershell
npm.cmd run dev -- pr review --base HEAD~1 --multi-agent
```

## 4. GitHub PR 只读评审

```powershell
$env:GITHUB_TOKEN = 'ghp_***'
npm.cmd run dev -- pr review --github openai/example#123 --multi-agent
```

也可以使用完整链接：

```powershell
npm.cmd run dev -- pr review --github https://github.com/openai/example/pull/123 --json
```

GitHub 接入只获取 PR Diff，不会写评论、创建分支、合并 PR 或修改远程仓库。

## 5. 生成并验证补丁

```powershell
npm.cmd run dev -- pr repair --base HEAD~1 --finding finding-1 --test-command "npm.cmd test"
```

补丁必须经过人工确认；验证失败时会自动回滚。

## 6. 查看和恢复失败运行

```powershell
npm.cmd run dev -- pr trace list
npm.cmd run dev -- pr trace replay <run-id>
npm.cmd run dev -- pr trace resume <run-id> --multi-agent
```

只有包含 `baseRef`、`diffPath` 或 `githubRef` 的运行可以恢复。仅使用内联 Diff 的运行不会把原始代码写入 Trace，因此不能自动恢复。

