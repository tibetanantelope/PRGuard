# PRGuard v0.1 规格说明

## 目标

v0.1 只验证一个本地闭环：

```text
本地 Git Diff → 风险 Finding → 代码 Evidence → 可解析 ReviewResult
```

这一阶段不应用 Patch，不接 GitHub，不引入多 Agent。

## 输入

Review 输入必须包含工作目录，并且至少包含以下一种来源：

- `baseRef`：Git 基准版本；
- `diffPath`：本地 Diff 文件路径；
- `diffText`：直接传入的 Diff 内容。

可选字段：

- `headRef`：Git 目标版本；
- `testCommand`：后续验证阶段使用的测试命令。

示例：

```json
{
  "cwd": "D:/workspace/demo",
  "baseRef": "HEAD~1",
  "headRef": "HEAD",
  "testCommand": "npm test"
}
```

## Finding 要求

每个 Finding 必须包含：

- 风险类别；
- 严重等级；
- 置信度；
- 文件路径；
- 起止行号；
- 明确标题；
- 至少一条 Evidence；
- 风险原因；
- 修复建议；
- 验证状态。

风险类别暂定为：

```text
security
reliability
code_quality
```

严重等级暂定为：

```text
low
medium
high
critical
```

## Evidence 要求

Evidence 必须能够回答：

1. 风险发生在哪个文件？
2. 对应哪几行代码？
3. 相关代码是什么？
4. 为什么这些代码能够证明风险存在？

不能只输出“可能存在安全问题”这类无定位、无依据的结论。

## v0.1 验收案例

### Case 1：高风险命令拼接

变更代码将用户输入直接拼接到 Shell 命令中。

期望：

- 识别为 `security`；
- 严重等级至少为 `high`；
- 定位到具体文件和行号；
- Evidence 包含命令拼接代码；
- 解释输入如何影响命令执行。

### Case 2：路径穿越风险

变更代码使用未经限制的用户输入拼接文件路径。

期望：

- 识别为 `security`；
- 定位路径拼接位置；
- 给出规范化路径和工作区边界校验建议。

### Case 3：异常处理缺失

变更代码调用外部服务，但没有处理超时、异常或失败响应。

期望：

- 识别为 `reliability`；
- Evidence 指向外部调用；
- 建议增加超时、错误处理或重试策略。

### Case 4：正常变更不应误报

变更只包含纯函数重命名、注释调整或已经经过参数校验的安全代码。

期望：

- 不输出高置信度高危 Finding；
- 如果无法证明风险，应降低置信度或不报告。

### Case 5：跨文件上下文

Diff 中只修改调用方，真正的参数校验逻辑位于另一个文件。

期望：

- Agent 能读取相关文件；
- 结合调用方和被调用方判断风险；
- Evidence 可以包含多个文件。

## v0.1 完成标准

- 数据模型和 Zod Schema 已实现；
- 非法 Finding 能够被拒绝；
- 合法 Finding 能够被解析；
- ReviewResult 能够被序列化为 JSON；
- 上述验收案例已经形成固定测试样例；
- 当前阶段不会修改用户仓库文件。

