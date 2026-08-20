# PRGuard 开发计划

## 1. 项目定位

PRGuard 是一个面向研发流程的 PR 风险治理与安全修复 Agent。

它基于 MiniCode 现有的 Agent Runtime，围绕本地 Git 仓库中的 Pull Request / Git Diff，完成：

```text
风险发现 → 证据复核 → 修复建议 → Patch 生成 → 测试验证 → 安全应用或回滚
```

项目重点不是简单生成代码审查意见，而是构建一个有证据、可验证、可追踪、可回滚的 Agent 闭环。

## 2. 项目目标

### 2.1 产品目标

给定一个本地 Git Diff，PRGuard 能够：

1. 识别代码变更中的安全性、可靠性和质量风险；
2. 输出结构化的 Finding 和 Evidence；
3. 生成可审查的修复 Patch；
4. 在用户批准后应用修改；
5. 自动运行测试、Lint 或类型检查；
6. 在验证失败时恢复原始状态；
7. 保存完整的 Agent 执行 Trace；
8. 通过离线评测集持续验证效果。

### 2.2 技术目标

重点展示以下 Agent 工程能力：

- Tool Calling
- Agent Loop
- 代码仓库上下文理解
- 结构化输出
- Evidence-grounded Analysis
- Human-in-the-loop
- Patch 验证与回滚
- Checkpoint / Resume
- Run Trace
- Prompt / Skill 管理
- Agent Evaluation
- MCP 扩展

## 3. v0.1 范围

### 3.1 v0.1 包含

- 本地 Git 仓库；
- 本地 Git Diff 输入；
- 单 Agent PR 风险分析；
- 文件读取、代码搜索和测试执行工具；
- 结构化 Finding / Evidence 输出；
- 风险等级和置信度；
- 基础 Patch 生成；
- 人工审批后应用 Patch；
- 测试失败自动回滚；
- 基础任务日志和执行结果。

### 3.2 v0.1 暂不包含

- GitHub App 和远程 Webhook；
- 自动合并 Pull Request；
- 生产环境自动修复；
- Redis、消息队列和高并发调度；
- 复杂的多 Agent 编排；
- Prompt 自动进化；
- 复杂数据库和在线管理后台。

这些功能放到后续阶段，避免项目在早期变成功能堆叠。

## 4. 第一批风险类型

第一版优先支持以下风险类别：

### 4.1 Security

- 命令注入；
- SQL 注入；
- 路径穿越；
- 敏感信息泄露；
- 权限校验缺失；
- 不安全的反序列化。

### 4.2 Reliability

- 异常处理缺失；
- 超时和重试缺失；
- 资源未释放；
- 并发安全问题；
- 空值或边界条件处理缺失。

### 4.3 Code Quality

- 明显重复逻辑；
- 复杂度过高；
- API 行为变化但缺少兼容处理；
- 关键逻辑缺少测试。

第一版不追求覆盖所有规则，优先保证少量规则能够稳定检测、解释和验证。

## 5. 核心输出结构

每个风险统一输出结构化 Finding：

```json
{
  "id": "finding-001",
  "category": "security",
  "severity": "high",
  "confidence": 0.92,
  "file": "src/auth.ts",
  "lineStart": 42,
  "lineEnd": 45,
  "title": "用户输入未经校验",
  "evidence": [
    {
      "file": "src/auth.ts",
      "lineStart": 42,
      "lineEnd": 45,
      "content": "相关代码片段"
    }
  ],
  "reason": "风险产生的原因和调用链说明",
  "suggestedFix": "建议的修复方式",
  "verification": {
    "status": "pending",
    "commands": ["npm test"]
  }
}
```

要求：

- 不能只输出自然语言结论；
- 每个 Finding 必须关联代码位置；
- 每个高风险结论必须提供证据；
- Finding 可以被评测程序解析；
- Patch 和测试结果必须与 Finding 关联。

## 6. 目标使用流程

第一版目标命令形式：

```powershell
minicode pr review --base HEAD~1 --head HEAD
```

也支持直接读取 Diff 文件：

```powershell
minicode pr review --diff change.diff
```

目标运行流程：

```text
读取 Git Diff
  ↓
识别变更文件
  ↓
读取相关上下文
  ↓
调用模型进行风险分析
  ↓
输出 Finding 和 Evidence
  ↓
用户选择某个 Finding
  ↓
生成 Patch
  ↓
展示 Patch 并请求审批
  ↓
应用 Patch
  ↓
运行测试、Lint 或类型检查
  ↓
验证通过则保留
验证失败则回滚
```

## 7. 系统架构

```text
┌─────────────────────────┐
│       PR CLI / TUI       │
└────────────┬────────────┘
             │
┌────────────▼────────────┐
│      PR Review Runtime   │
│                          │
│  Task State              │
│  Agent Loop              │
│  Context Manager         │
│  Permission Manager      │
│  Budget / Timeout        │
└──────┬──────────┬────────┘
       │          │
┌──────▼─────┐ ┌──▼────────────┐
│ Model       │ │ Tool Registry │
│ Adapter     │ │               │
│             │ │ Git / File    │
└─────────────┘ │ Test / Search │
                └──────┬────────┘
                       │
              ┌────────▼────────┐
              │ Finding / Patch  │
              │ Verification     │
              └────────┬────────┘
                       │
              ┌────────▼────────┐
              │ Run Trace / Eval │
              │ Replay / Report  │
              └─────────────────┘
```

## 8. 分阶段开发计划

### 阶段一：确定数据模型和验收标准

目标：明确 PRGuard v0.1 的边界。

任务：

- 定义 Finding 类型；
- 定义 Evidence 类型；
- 定义 Patch 和 Verification 类型；
- 定义 PR Review 输入类型；
- 确定风险类别和严重等级；
- 确定命令行入口；
- 编写第一批验收案例。

验收标准：

- 给定一个本地 Diff，可以得到稳定的结构化输出；
- 输出至少包含文件、行号、证据和风险原因；
- Agent 不会在未审批时修改用户代码。

### 阶段二：实现本地 PR Diff 输入

目标：让 Agent 能理解一次 PR 变更。

任务：

- 增加 Git Diff 工具；
- 获取变更文件列表；
- 读取变更文件完整内容；
- 获取项目目录结构；
- 加载项目规则和 Skills；
- 支持 Diff 文件输入。

### 阶段三：实现单 Agent 风险分析

目标：先建立可运行的单 Agent 基线。

任务：

- 编写 PR Review System Prompt；
- 注册 Git 和代码分析工具；
- 强制模型输出结构化 Finding；
- 校验模型输出；
- 处理不完整或非法输出；
- 支持风险等级和置信度。

### 阶段四：实现安全修复闭环

目标：从“发现问题”扩展到“验证修复”。

任务：

- 根据 Finding 生成 Patch；
- 展示 Patch Diff；
- 增加人工审批；
- 应用 Patch；
- 运行测试、Lint 和类型检查；
- 失败时自动恢复；
- 保存修复前后状态。

### 阶段五：实现 Run Trace 和 Checkpoint

目标：让一次 PR 处理过程可解释、可恢复、可复盘。

记录内容：

- 任务开始和结束；
- 模型版本；
- Prompt / Skill 版本；
- 模型请求；
- 工具调用和工具结果；
- Finding 生成；
- Patch 生成；
- 审批结果；
- 测试结果；
- 回滚结果；
- Checkpoint。

### 阶段六：建立离线评测系统

目标：用数据证明 PRGuard 的效果。

目录规划：

```text
evals/
├── tasks.jsonl
├── fixtures/
├── expected/
└── runner.ts
```

第一批准备 20～30 个样本，后续扩展到 50～100 个样本。

评测指标：

- Finding Precision；
- Finding Recall；
- Finding F1；
- 风险定位准确率；
- 高风险问题召回率；
- Patch 测试通过率；
- 平均工具调用次数；
- 平均 Token 消耗；
- 平均执行耗时；
- 任务失败率。

### 阶段七：引入多 Agent 和 Skills

目标：在单 Agent 基线稳定后增加专业分工。

角色规划：

```text
Security Agent
Reliability Agent
Code Quality Agent
Finding Aggregator
```

每个 Agent 使用统一的 Finding / Evidence 数据结构，聚合器负责：

- 结果去重；
- 结果合并；
- 冲突处理；
- 置信度校准；
- 风险排序。

### 阶段八：GitHub 集成和项目包装

目标：形成可以演示和写入简历的完整项目。

后续功能：

- GitHub PR Webhook；
- 读取远程 PR Diff；
- 回写 Review Comment；
- 创建修复分支；
- 提交修复 Patch；
- 回写验证结果；
- 失败任务回放；
- 评测报告页面。

## 9. 第一版明确的安全边界

- 默认只读取和分析代码；
- 不自动合并 PR；
- 不直接修改生产环境；
- Patch 应用必须经过人工审批；
- 高风险命令必须二次确认；
- 测试在隔离工作区执行；
- 设置最大 Agent 步数；
- 设置最大执行时间；
- 设置最大 Token 或成本预算；
- 所有修改支持回滚。

## 10. 当前代码复用计划

| 现有模块 | PRGuard 用途 |
|---|---|
| `src/agent-loop.ts` | PR 分析和修复执行循环 |
| `src/anthropic-adapter.ts` | OpenRouter / Anthropic-compatible 模型接入 |
| `src/tool.ts` | 工具注册、参数校验和执行 |
| `src/tools/index.ts` | 注册 Git、文件、测试相关工具 |
| `src/permissions.ts` | Patch 应用和命令执行审批 |
| `src/session.ts` | 保存 PR Review 会话 |
| `src/memory.ts` | 加载项目编码规则 |
| `src/skills.ts` | 加载 Security / Reliability Skills |
| `src/mcp.ts` | 接入 GitHub、CI 或代码扫描服务 |
| `src/compact/` | 处理大型 Diff 和长上下文 |
| `src/agents/` | 后续实现多 Agent 协作 |
| `src/utils/tool-result-storage.ts` | 保存大型工具结果 |

## 11. 项目验收标准

### v0.1

- 可以分析本地 Git Diff；
- 可以输出结构化 Finding；
- Finding 包含代码证据；
- 支持风险等级和置信度；
- 不审批不会修改代码；
- 可以生成 Patch；
- Patch 可以被测试验证；
- 测试失败可以回滚；
- 运行过程可以查看日志。

### v0.2

- 支持 Run Trace；
- 支持 Checkpoint / Resume；
- 支持离线评测集；
- 支持评测报告；
- 支持 Prompt / Skill 版本记录；
- 支持失败任务回放。

### v1.0

- 支持多 Agent 专业分工；
- 支持 GitHub PR；
- 支持自动发布 Review Comment；
- 支持修复分支；
- 支持历史版本对比；
- 支持一键回滚；
- 形成完整演示案例。

## 12. 简历项目产出目标

最终简历项目名称：

> PRGuard：面向研发流程的 PR 风险治理与安全修复 Agent

建议最终展示以下数据：

- 评测数据集规模；
- 风险类型数量；
- Finding F1；
- 高风险召回率；
- Patch 测试通过率；
- 平均工具调用次数；
- 平均执行耗时；
- 失败恢复成功率。

所有指标必须能够通过仓库中的数据集和命令复现。

## 13. 当前下一步

先完成阶段一：

1. 设计 `Finding`、`Evidence`、`Patch`、`Verification` 类型；
2. 设计 PR Review 输入和输出格式；
3. 确定第一批风险类型；
4. 编写 v0.1 验收案例；
5. 再开始实现本地 Diff 输入。

第一阶段完成之前，不扩展 GitHub、Redis、高并发和复杂多 Agent 功能。
