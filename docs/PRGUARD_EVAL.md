# PRGuard 离线评测

阶段六提供一套不依赖大模型、不产生 API 成本的 PR 风险评测流程。

## 数据集结构

```text
evals/
├── tasks.jsonl
├── fixtures/       # 最小化 unified diff
└── expected/       # 人工标注的期望 Finding
```

每条任务记录都必须包含：

- `datasetVersion`：数据集版本，例如 `v1`；
- `split`：`validation` 或 `holdout`，用于防止调参集和最终验收集混用；
- `riskCategories`：任务涉及的风险类别，可同时包含多个类别；
- `difficulty`：`easy`、`medium` 或 `hard`；
- `repair`：是否要求进入补丁生成和验证流程，以及预期结果。

当前内置 57 个 v2 样本：37 个 validation 样本和 20 个 holdout 样本，保留 v1 的基础样本，并新增参数化 SQL、非 Shell 命令、路径边界、URL 白名单和显式超时等 hard negative，以及 SQL、命令、路径和可靠性风险的代码变体。数据集包含多风险样本、安全负样本和 5 个修复任务。这个数据集用于优化后的对照实验，最终简历数字仍应以真实 Agent 在 Holdout 集上的运行结果为准。

评测器会拒绝空数据集、重复任务 ID、混用多个数据集版本，以及缺少 validation 或 holdout 的数据集。

## 运行规则基线

```powershell
npm.cmd run dev -- pr eval --baseline
npm.cmd run dev -- pr eval --baseline --json
```

规则基线只用于建立可重复的下限，不代表最终 Agent 能力。它会扫描 Diff 中新增行，并输出标准化的 Finding。

## 评估模型输出

模型结果可以保存为 JSONL，每行对应一个任务：

```json
{"taskId":"command-injection","findings":[{"category":"security","severity":"high","file":"src/runner.ts","lineStart":1,"lineEnd":1,"title":"..."}],"toolCalls":3,"tokens":1200,"durationMs":1800,"patchTestPassed":true}
```

然后运行：

```powershell
npm.cmd run dev -- pr eval --predictions model-predictions.jsonl
npm.cmd run dev -- pr eval --predictions model-predictions.jsonl --json

# 将模型预测与规则基线进行对比
npm.cmd run dev -- pr eval --predictions model-predictions.jsonl --compare-baseline
npm.cmd run dev -- pr eval --predictions model-predictions.jsonl --compare-baseline --json

# 作为 CI 回归门禁：失败时返回非 0 退出码
npm.cmd run dev -- pr eval --predictions model-predictions.jsonl --gate --min-f1 0.70 --min-high-risk-recall 0.90 --max-failure-rate 0.10 --json
```

`--gate` 会自动与规则基线比较，并检查显式阈值。支持的阈值参数为：

- `--min-f1 <0..1>`：Finding F1 最低值；
- `--min-high-risk-recall <0..1>`：高风险 Finding 召回率最低值；
- `--min-patch-pass-rate <0..1>`：Patch 测试通过率最低值；
- `--max-failure-rate <0..1>`：任务失败率最高值。

预测文件必须为数据集中的每个任务提供且仅提供一条记录；缺失任务、重复任务和未知任务都会直接使评测失败。这样模型、Prompt 或规则升级后，可以在 CI 中阻止指标回退。

## 统一实验运行器

阶段三提供 `runEvaluationExperiment` 运行器。它接收一个统一的任务执行函数，负责遍历数据集、按任务捕获异常、记录耗时和运行元数据，并在输出目录生成：

```text
<outputDir>/
├── manifest.json       # runId、数据集版本、split、模型、Prompt 版本、失败任务
├── predictions.jsonl   # 每个任务的 Finding 和 Token/工具调用/耗时/失败原因
└── report.json         # 由统一评测器计算的指标报告
```

运行器支持 `split: validation` 或 `split: holdout`。四种实验配置应复用同一个运行器，只替换任务执行函数，保证实验结果的统计口径一致。`runEvaluationExperiment` 目前作为库接口提供，真实 Rule、Single-Agent、Multi-Agent 接入在后续阶段完成。

阶段四增加了 PRGuard 实验适配层和 CLI：

```powershell
npm.cmd run dev -- pr eval-run --mode rule-baseline --split holdout --output evals/reports/rule-holdout
npm.cmd run dev -- pr eval-run --mode single-agent --split validation --output evals/reports/single-validation
npm.cmd run dev -- pr eval-run --mode multi-agent --split validation --output evals/reports/multi-validation
npm.cmd run dev -- pr eval-run --mode multi-agent-verifier --split holdout --output evals/reports/multi-verifier-holdout
npm.cmd run dev -- pr eval-run --mode adaptive --split holdout --output evals/reports/adaptive-holdout
```

Agent 模式从当前运行时配置读取模型和认证信息；`--model`、`--prompt-version` 和 `--run-id` 可用于固定实验元数据。Rule Baseline 不需要模型配置。四种模式都会生成相同结构的 `manifest.json`、`predictions.jsonl` 和 `report.json`，其中 Agent 模式还会在 `traces/` 保存每个任务的运行轨迹。

Multi-Agent 编排默认对每个 specialist 做 1 次重试，并使用 `PR_GUARD_REVIEW_TIMEOUT_MS` 作为单专家超时上限。某个 specialist 失败不会丢弃其他专家的结果；只有全部 specialist 失败时，才会自动执行一次无角色的 Single-Agent fallback。每次尝试、超时、失败和 fallback 都会记录到 Run Trace，最终结果的 `agents` 与 `aggregation.fallbackUsed` 字段可用于统计降级比例。

Finding 聚合按严重等级动态门控：`high` / `critical` Finding 优先保留，避免专家类别边界或低置信度导致高风险漏报；`medium` Finding 需要至少两个独立专家支持或 0.85 以上置信度；`low` Finding 需要多个专家支持或 0.90 以上置信度。高风险跨专家类别的结果会保留，但会通过 `categoryMismatchAcceptedFindingCount` 记录，便于后续评测误报。

Adaptive 模式先执行一次 Single-Agent 初审，仅在发现高风险、低置信度、多风险 Diff 或多个风险类别时升级到 Multi-Agent。路由结果会写入 `routing.escalated` 和 `routing.reasons`，可据此统计升级比例和额外成本。

Verifier 在 Multi-Agent 聚合完成后选择性执行，不再由每个 specialist 对全部 Finding 重复验证。默认选择未获得多专家支持或置信度低于 0.80 的 Finding；也支持通过 Finding ID 显式指定验证范围。未被选中的 Finding 保留基础聚合结果，从而避免 Verifier 对整个结果集过度过滤。

## 指标定义

- Finding Precision / Recall / F1：按风险类别、文件和相邻代码行匹配 Finding。
- Localization Accuracy：匹配到正确文件和代码位置的比例。
- High-risk Recall：`high` 与 `critical` Finding 的召回率。
- Patch Test Pass Rate：预测文件中提供 `patchTestPassed` 时计算，否则显示 `n/a`。
- Repair Task Count：进入补丁流程的任务数量。
- Patch Generation / Apply Success Rate：补丁生成和隔离应用成功率。
- Rollback Verification Rate：验证失败后原工作区保持未修改的比例。
- End-to-end Repair Success Rate：识别、生成、应用、测试全部成功的比例。
- Average Tool Calls / Tokens / Duration：预测文件提供对应字段时统计。
- Task Failure Rate：预测文件中 `failed: true` 的任务比例。
- False Positives / False Negatives：分别表示多报和漏报的 Finding 数量。

## Evidence Verifier 语义校验

Evidence Verifier 采用两层校验：

1. Grounding 校验：确认 Finding 指向变更文件，并且 Diff 类型证据的代码片段确实存在于本次 Diff 中。
2. 语义反证校验：当新增代码包含强相关的安全约束时，抑制非 critical Finding，例如参数化 SQL、`execFile(..., { shell: false })`、命令白名单、路径边界检查，以及显式的超时、重试、清理或异常处理。

被拒绝的 Finding 会在 `evidenceVerification.rejectionReasons` 中保留机器可读原因，便于 Run Trace 和离线评测复盘。Critical Finding 不会仅因为启发式安全信号而被自动删除，仍保留给人工确认。

## 策略级运行指标

评测报告除了质量指标，还记录策略级运行遥测：Adaptive 的任务数、升级数与升级率；Evidence Verifier 的调用数、检查 Finding 数与拒绝数；以及 specialist 失败数和 Single-Agent fallback 任务数/比例。这些字段不是新的质量分数，而是用于解释准确率、召回率与模型调用成本之间的关系。

## 基线回归

`--compare-baseline` 会在同一数据集上运行规则基线，并输出候选模型相对于基线的指标差值。当前将 Finding F1、高风险召回率下降和任务失败率上升标记为回归，适合在模型升级或 Prompt 修改后作为发布前检查。

评测器只负责比较结果，不会自动修改仓库，也不会执行预测文件里的命令。补丁是否安全，应由阶段四的 Patch 应用和验证流程单独确认。
