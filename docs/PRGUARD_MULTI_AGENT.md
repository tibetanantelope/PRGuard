# PRGuard 多 Agent 评审

阶段七提供三个职责清晰的只读专业 Agent：

- `Security Agent`：注入、鉴权、路径、密钥、反序列化和信任边界。
- `Reliability Agent`：异常、重试、超时、资源释放、并发和边界条件。
- `Code Quality Agent`：回归风险、测试缺口、API 兼容性和脆弱逻辑。

每个 Agent 使用独立的评审角色和 Skill，但共享相同的 Diff、仓库上下文与结构化 Finding Schema。三个 Agent 并行运行，任何一个失败不会直接丢弃其他 Agent 的结果；全部失败时任务才失败。

聚合器会：

1. 按风险类别、文件和相邻代码行匹配重复 Finding。
2. 保留更高严重级别和更可靠的主 Finding。
3. 合并不同 Agent 的 Evidence。
4. 对多个 Agent 共同确认的问题增加置信度，并记录支持数量。
5. 输出 `agents` 和 `aggregation` 元数据，方便 Trace 和离线评测。

运行方式：

```powershell
npm.cmd run dev -- pr review --base HEAD~1 --multi-agent
npm.cmd run dev -- pr review --diff change.diff --multi-agent --json
```

关闭 `--multi-agent` 时仍然使用阶段三的单 Agent 基线，便于做成本、耗时和准确率对比。

内置 Skill 位于 `.mini-code/skills/`，也可以通过现有的 `minicode skills add` 安装或替换项目级 Skill。

