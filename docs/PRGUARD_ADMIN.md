# PRGuard 管理控制台

阶段十二新增轻量级 Web 管理控制台，不依赖 React、Vue 或额外构建工具。

启动 API 后访问：

```text
http://127.0.0.1:8787/admin
```

控制台包含：

- Review Job 数量、完成数、失败数和 Finding 数量概览
- Job 列表和状态
- 单个 Job 的完整结果详情
- Prometheus 指标展示
- 15 秒自动刷新

如果配置了 `PR_GUARD_API_KEY`，页面仍然可以打开，但需要在页面顶部输入 API Key，数据接口才会返回结果。API Key 只保存在当前页面内存中，不会写入代码或 URL。

当前控制台定位是单机演示和运维排障入口；后续可以继续扩展 Finding 过滤、Trace 时间线、Patch Diff 展示和用户权限管理。
