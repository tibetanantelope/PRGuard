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

如果配置了 `PR_GUARD_API_KEY` 或 `PR_GUARD_RBAC_JSON`，页面仍然可以打开，但需要在页面顶部输入具有对应权限的 Token，数据接口才会返回结果。Token 只保存在当前页面内存中，不会写入代码或 URL。

当前控制台定位是单机演示和运维排障入口；服务端始终执行 RBAC 与项目级隔离，不能通过控制台绕过。
