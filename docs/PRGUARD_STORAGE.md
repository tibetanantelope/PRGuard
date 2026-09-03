# PRGuard 持久化设计

阶段七开始，PRGuard 的业务数据不再只保存在 JSON 文件或内存中。

## MySQL 中保存什么

- `review_jobs`：异步审查任务状态、输入、重试次数和最终结果。
- `reviews`：一次审查的基本信息和完整结果快照。
- `findings`：按风险项拆分保存，便于按严重级别和审查记录查询。
- `patches`：Agent 生成的修复补丁及其状态。
- `trace_events`：模型请求、工具调用、审查完成和失败等运行事件。

## PostgreSQL + pgvector 中保存什么

- `memories`：项目隔离的 Episodic、Semantic、Procedural 和 Feedback 长期记忆。
- `embedding`：由配置的 Embedding Provider 生成的向量，用于语义相似度检索。
- `memory_embedding_outbox`：Embedding 失败后的持久化重试任务。

MySQL 负责 PRGuard 业务实体，PostgreSQL 负责长期记忆检索，两者不共享业务表。Memory 未配置 PostgreSQL 时仍可使用 JSONL fallback，适合单元测试。

审查和 Finding 使用事务写入；同一审查重复保存时会先清理旧 Finding，因此任务重试不会产生重复风险项。Trace 使用 `(run_id, sequence_no)` 幂等写入。

## 运行方式

当 `.env` 配置了 `PR_GUARD_MYSQL_URL` 时，CLI、API 和 Worker 会使用 MySQL 持久化；没有配置时自动降级到原来的文件任务仓库和无操作持久化实现，方便本地单元测试。

API/Worker 组合运行时，审查完成后可以用 MySQL 查看：

```sql
SELECT review_id, finding_count, created_at FROM reviews ORDER BY created_at DESC;
SELECT review_id, severity, category, file_path FROM findings ORDER BY created_at DESC;
SELECT run_id, sequence_no, event_type FROM trace_events ORDER BY created_at DESC;
```

已经存在的数据库只需要确保 `infra/mysql/init/001_schema.sql` 中的表结构已初始化；阶段七不会删除历史数据。
