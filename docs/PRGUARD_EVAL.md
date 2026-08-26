# PRGuard 离线评测

阶段六提供一套不依赖大模型、不产生 API 成本的 PR 风险评测流程。

## 数据集结构

```text
evals/
├── tasks.jsonl
├── fixtures/       # 最小化 unified diff
└── expected/       # 人工标注的期望 Finding
```

当前内置 6 个样本：命令注入、SQL 注入、路径穿越、异常吞掉、未完成 TODO，以及一个安全的文档变更。

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

## 指标定义

- Finding Precision / Recall / F1：按风险类别、文件和相邻代码行匹配 Finding。
- Localization Accuracy：匹配到正确文件和代码位置的比例。
- High-risk Recall：`high` 与 `critical` Finding 的召回率。
- Patch Test Pass Rate：预测文件中提供 `patchTestPassed` 时计算，否则显示 `n/a`。
- Average Tool Calls / Tokens / Duration：预测文件提供对应字段时统计。
- Task Failure Rate：预测文件中 `failed: true` 的任务比例。
- False Positives / False Negatives：分别表示多报和漏报的 Finding 数量。

## 基线回归

`--compare-baseline` 会在同一数据集上运行规则基线，并输出候选模型相对于基线的指标差值。当前将 Finding F1、高风险召回率下降和任务失败率上升标记为回归，适合在模型升级或 Prompt 修改后作为发布前检查。

评测器只负责比较结果，不会自动修改仓库，也不会执行预测文件里的命令。补丁是否安全，应由阶段四的 Patch 应用和验证流程单独确认。
