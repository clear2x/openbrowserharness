# Agent Note：过期供应商路由自愈——引擎启动前用适配器宇宙校验持久化路由

Status: implemented

[English](2026-09-12-stale-provider-route-self-heal.md) | 中文

## 问题

引擎用引擎设置里持久化的 `provider` 组装 `main` agent。`syncCustomProviders` 让适配器注册表与已声明的自定义档案保持同步——档案被删除时，其适配器一并注销。若存储的路由仍指向那个已删除的档案，则每次模型请求都会失败：`no adapter registered for provider "…"`（NO_ADAPTER），跨重启持续，唯一恢复手段是面板里手动切换模型。真机触发：删除路由对应的自定义档案后重启，扩展即带死上场（"ds-gw" 路由，适配器已注销）。

## 决策

- `settings-store.ts` 的 `resolveActiveProvider(persisted, presetIds, declaredRoutes)` 在引擎组装之前，用适配器宇宙——preset id 集合 + 已声明自定义路由——校验持久化路由。落在集合之外即回落 `DEFAULT_PROVIDER`（`deepseek`），`corrected: true`。
- offscreen boot 在 `compositionRows` 之前调用它，经 `writeEngineSettings` 持久化纠正，并以大声告警点名被丢弃的路由。过期指针因此跨一次重启自愈，而不是困死每一个轮次。

## 落选方案

- **组装后重绑运行中 agent 的路由**：暂缓——恢复会话的请求头重放里路由已冻结，重绑需要 bridge 按 agent 安装的 selection-ref 机制；boot 守卫直接阻止该状态出现，面板切换仍是手动恢复手段。
- **请求时回落到第一个已注册适配器（LLM 服务层）**：否——在请求路径里静默改道会掩盖配置/存储不一致，而 boot 守卫用点名告警暴露它；请求路径回落还会掩盖未来的注册缺陷。

## 后果

- 删除一个正在使用的自定义档案不再弄瘫引擎：下次重启以出厂 provider 组装并持久化纠正；面板显示出厂模型而不是每轮报错。
- 纠正每次启动单向生效（过期路由 → 出厂默认）；若被删除的正是用户偏好 provider，需重新选择一次——告警会点名被丢弃的路由，原因可见。
- `settings-profiles.spec.ts` 的 `resolveActiveProvider` 表格测试覆盖（preset/自定义保留、已删路由自愈、缺省/空白直通）。
