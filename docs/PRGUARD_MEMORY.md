# PRGuard Memory 2.0

PRGuard 的记忆系统不是聊天记录归档，而是参与 Agent 决策并能被验证、修正和淘汰的闭环。短期记忆负责当前 Run 的确定性执行状态；长期记忆负责跨 Run 复用经验。

## 分层模型

| 层级 | 内容 | 生命周期 | 主要用途 |
|---|---|---|---|
| Working Memory | 目标、计划 DAG、当前步骤、事实、文件、副作用、错误和待执行动作 | 当前 Run，可随 Checkpoint 恢复 | 维持执行连续性，避免重复副作用 |
| Episodic Memory | PR 审查、失败、Patch、验证结果和 Agent 对话经历 | 跨 Run | 回忆相似任务及其结果 |
| Semantic Memory | 项目事实、Finding 模式和从重复经历归纳出的规则 | 跨 Run | 提供稳定项目知识 |
| Feedback Memory | 人工接受、拒绝或修改 Finding 的反馈 | 跨 Run，最高来源权威 | 校准后续审查结果 |

所有长期记忆均按项目隔离，并记录来源、置信度、使用次数、成功/失败次数、状态、更新时间和 Provenance。敏感文本在进入 PRGuard Memory 前会经过脱敏。

## 混合检索与重排

检索器并行读取三类长期记忆，计算以下可解释分数：

```text
total = 0.34 * lexical
      + 0.28 * semantic
      + 0.16 * confidence * recency
      + 0.10 * reinforcement
      + 0.12 * source_authority
      + category_boost
```

- lexical 使用词项重合；
- semantic 通过可替换的 `MemoryEmbeddingProvider` 计算余弦相似度；
- 默认接口支持本地特征哈希和远程 Embedding；当前推荐生产/演示配置使用阿里云 `text-embedding-v4`，离线测试可切换为 hash；
- recency 使用时间衰减；
- reinforcement 综合记忆被采用后的成功/失败记录；
- source authority 遵循人工反馈高于系统事件、系统事件高于 Agent 推断；
- 最终结果执行归一化去重和多样性重排，减少近似记忆挤占上下文。

每条召回结果携带完整分数组成、冲突键和被抑制的冲突数量。Agent Runtime 与 PRGuard Run Trace 都会记录召回 ID、类型、来源、分数和 Provenance，便于解释一次回答使用了哪些历史经验。

## 冲突、强化与归纳

同一 `conflictKey`、`findingKey` 或 `factKey` 的记录会进入冲突集合。系统优先选择人工来源；相同来源再比较更新时间和置信度。该策略可以让人工拒绝的历史 Finding 覆盖旧的 Agent 判断，而不是让两条互相矛盾的内容同时进入上下文。

召回时增加 `usageCount`。任务成功后增加 `successCount` 并小幅提高置信度，任务失败则增加 `failureCount` 并降低置信度。通用 Agent Turn 和 PRGuard Review 的成功、失败路径都接入了这一反馈环。

重复 Episodic Memory 达到阈值后，会生成稳定 ID 的 Semantic Memory。归纳结果保存全部源记忆 ID，不会丢失可追溯关系。PR 审查、失败和 Patch 记录都会自动触发归纳。

## 容量治理

三类长期记忆分别设置容量上限。超限后按照来源权威、置信度、使用频率、成功收益和失败惩罚计算效用，低效用记录以追加事件的方式归档。归档是可审计的逻辑删除，不会直接破坏 JSONL 历史。

默认上限为：Episodic 500、Semantic 1000、Feedback 500。策略可在调用 `governCapacity` 时覆盖。

## 消融评测

`evaluateMemoryRetrieval` 计算 Recall@K 和 MRR，并允许分别关闭语义召回、时间衰减、使用强化、冲突消解和去重。测试集覆盖：

- 纯词法无法命中、混合检索可以命中的语义样本；
- 跨 Episodic/Semantic/Feedback 的去重与冲突消解；
- 成功/失败强化；
- 重复经历归纳及来源链；
- 容量淘汰；
- 开关语义检索前后的 Recall@K/MRR 对照。

运行：

```powershell
node --import tsx --test test/memory-v2.test.ts
```

## 工程边界

当前正式长期记忆后端为 PostgreSQL + pgvector，业务数据仍由 MySQL 保存，Redis 负责异步任务。Store 与 Embedding Provider 已解耦：PostgreSQL 后端支持远程 Embedding，JSONL + hash 仍保留给离线单元测试和无基础设施开发。当前部署是单实例本地/开发架构，尚未声称具备数据库高可用、分布式分片或跨区域容灾能力。

PostgreSQL 初始化脚本位于 `infra/postgres/init/002_memory.sql`。当 Embedding API 暂时失败时，记忆先以 `failed` 状态保存，并进入 `memory_embedding_outbox`，可通过 `npm.cmd run memory:retry-embeddings` 重试。
