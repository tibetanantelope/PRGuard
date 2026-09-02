# PRGuard v1 评测失败分析

## 1. 分析范围

本报告基于 PRGuard v1 的最终评测产物，目标是定位 Multi-Agent v1 没有稳定优于 Single-Agent v1 的原因，为后续 v2 优化提供依据。

- 数据集：45 个 PR Diff 样本
- Validation：30 个样本
- Holdout：15 个样本
- 模型：`gpt-5.5`
- Prompt：`prguard-review-v1`
- 对比模式：规则基线、Single-Agent、Multi-Agent、Multi-Agent + Evidence Verifier

本阶段只做结果分析和问题归因，不宣称任何 v2 优化已经完成。

## 2. 总体结果

| 模式 | Split | Finding Precision | Finding Recall | Finding F1 | 高风险召回 | 失败任务 |
|---|---:|---:|---:|---:|---:|---:|
| Rule baseline | Validation | 100.0% | 38.5% | 55.6% | 53.3% | 0 |
| Single-Agent | Validation | 61.8% | 80.8% | 70.0% | 93.3% | 0 |
| Multi-Agent | Validation | 48.9% | 84.6% | 62.0% | 93.3% | 0 |
| Multi-Agent + Verifier | Validation | 43.8% | 80.8% | 56.8% | 93.3% | 0 |
| Rule baseline | Holdout | 100.0% | 41.7% | 58.8% | 60.0% | 0 |
| Single-Agent | Holdout | 84.6% | 91.7% | **88.0%** | **100.0%** | 0 |
| Multi-Agent | Holdout | 75.0% | 75.0% | 75.0% | 60.0% | 2 |
| Multi-Agent + Verifier | Holdout | 55.0% | 91.7% | 68.7% | 100.0% | 0 |

当前结论是：Single-Agent v1 在 Holdout 上是最好的已验证模式；Multi-Agent v1 提高了部分召回能力，但误报和运行失败抵消了收益。Evidence Verifier v1 能改善部分高风险召回，但没有解决语义误报问题。

## 3. 误报、漏报与运行失败

### 3.1 误报数量

| 模式 | Validation 误报 | Holdout 误报 |
|---|---:|---:|
| Single-Agent | 13 | 2 |
| Multi-Agent | 23 | 3 |
| Multi-Agent + Verifier | 27 | 9 |

误报主要集中在“代码表面上类似风险模式，但上下文已经完成约束或不存在可利用路径”的样本。典型安全负例包括：

- `negative-execfile-01`
- `negative-sql-01`
- `negative-path-01`
- `negative-error-01`
- `negative-http-01`
- `negative-timeout-01`

这说明当前系统更擅长发现“像风险”的代码，而不擅长证明“为什么这里不是风险”。对于 PR 审查场景，这会直接增加开发者噪声和人工复核成本。

### 3.2 漏报数量

| 模式 | Validation 漏报 | Holdout 漏报 |
|---|---:|---:|
| Single-Agent | 5 | 1 |
| Multi-Agent | 4 | 3 |
| Multi-Agent + Verifier | 5 | 1 |

Multi-Agent 在 Validation 上的漏报略少，但在 Holdout 上出现了更多漏报，说明一次运行的结果仍然存在模型随机性和路由不稳定性，不能只依据一个 split 或一次运行下结论。

### 3.3 Multi-Agent 运行失败

Multi-Agent Holdout 有两个任务失败：

- `cmd-template-02`
- `sql-format-02`

两者的失败原因都是 `All PRGuard specialist agents failed.`。这不是单个 Finding 判断错误，而是编排层把“所有专家暂时失败”直接升级成整条任务失败，暴露出两个工程问题：

1. 专家 Agent 缺少独立重试和降级策略。
2. 部分专家失败时没有保留可用的部分结果。

## 4. 成本与收益

| 模式 | Split | 平均工具调用 | 平均 Token | 平均耗时 |
|---|---:|---:|---:|---:|
| Single-Agent | Validation | 4.7 | 5,604 | 33.1s |
| Multi-Agent | Validation | 11.0 | 19,060 | 30.6s |
| Multi-Agent + Verifier | Validation | 12.2 | 17,890 | 36.0s |
| Single-Agent | Holdout | 4.9 | 6,615 | 30.4s |
| Multi-Agent | Holdout | 11.1 | 27,415 | 70.5s |
| Multi-Agent + Verifier | Holdout | 12.1 | 20,719 | 36.2s |

Multi-Agent 的工具调用量约为 Single-Agent 的 2 倍以上，Holdout 平均 Token 约为 4 倍，且出现了 13.3% 的任务失败率。当前没有足够证据证明这些成本换来了稳定的质量提升。

## 5. 根因假设

### 5.1 聚合策略过于宽松

当前多个专家的结果容易被直接合并。只要某个专家识别出疑似风险，就可能进入最终 Finding 集合，导致不同专家的召回能力叠加了，但误报也被叠加。

### 5.2 专家边界不够严格

Security、Reliability、Code Quality 专家都接收完整 Diff，且缺少强约束的风险类别门控。结果是专家可能跨类别扩展判断，产生重复 Finding 或越权 Finding。

### 5.3 Verifier 主要验证证据，而不是验证风险是否真实

Evidence Verifier 能检查 Finding 是否引用了 Diff 中真实存在的行和代码片段，但“证据存在”不等于“风险成立”。对于带有安全约束、参数化查询、白名单或异常处理的负例，Verifier 仍可能接受一个证据充分但结论错误的 Finding。

### 5.4 编排失败缺少局部容错

当多个专家同时遇到模型/API/解析异常时，系统直接返回所有专家失败。缺少按专家重试、超时隔离、部分成功、Single-Agent fallback，使得一次局部故障变成整条评测任务失败。

### 5.5 数据规模仍适合发现问题，不适合证明泛化

45 个样本、15 个 Holdout 已经足以暴露明显回归，但不足以支撑非常强的泛化结论。后续需要增加 hard negative、同类变体和重复运行，并报告均值或置信区间。

## 6. v2 优化优先级

1. **先改 Finding 聚合**：按风险类别、文件位置和规范化指纹去重；区分单专家候选与最终确认 Finding。
2. **增加置信度门控**：高风险保留高召回策略；中低风险要求至少两个独立专家支持，或必须通过更严格的语义验证。
3. **强化负例验证**：Verifier 不仅验证证据是否存在，还要检查是否存在白名单、参数化、边界校验、错误处理等反证。
4. **完善局部容错**：专家级重试、超时隔离、部分结果保留，并在所有专家失败时使用可观测的降级路径。
5. **控制成本**：只把与风险类别相关的 Diff 片段发送给专家；让 Verifier 只处理高价值或存在冲突的 Finding。
6. **扩充 v2 数据集并重复运行**：加入更多 hard negative、对抗性证据和同类变体，在相同 Validation/Holdout 上重新比较。

## 7. 当前可用于简历的结论

可以如实表述为：PRGuard 已建立包含 45 个 PR Diff 的离线评测集和 Single/Multi-Agent 对照实验；在 15 个 Holdout 样本上，Single-Agent Finding F1 达到 88.0%，高风险召回率达到 100.0%，相比规则基线 F1 提升 29.2 个百分点。同时，实验暴露了 Multi-Agent 聚合误报、专家失败隔离和负例语义验证等问题，并形成了下一版优化方向。

不建议在 v2 优化完成前宣称“Multi-Agent 一定优于 Single-Agent”，也不建议把当前 5 个 repair task 的修复成功率写入简历，因为本轮评测尚未真正执行完整的补丁生成、应用、测试和回滚链路。
