---
description: "面向浏览器与扩展宿主的 IndexedDB PersistenceBackend，构建于共享 PersistenceCoordinator 之上。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-indexeddb

[English](README.md) | 中文


## 概述

为浏览器/扩展宿主把事件溯源的会话持久化到 IndexedDB：一个数据库（默认 `dsh-sessions`），含 `sessions` 存储（keyPath `sessionId`，头部 + revision + createdAt）与 `events` 存储（keyPath `[sessionId, seq]`，只追加行）。它在共享的 `PersistenceCoordinator` 之上实现 `PersistenceBackend` 钩子，因此缓冲、收养、崩溃修复顺序与销毁静默都与 JSONL/SQLite 后端完全一致。

## 目录

- [存储与持久化映射](#存储与持久化映射)
- [配置与注入](#配置与注入)
- [模型体验](#模型体验)
- [已知限制与遗留工作](#已知限制与遗留工作)

## 存储与持久化映射

| 关注点 | 映射 |
|---|---|
| 物化 + 首批 | 一个 `readwrite` 事务同时写 sessions 行与首批事件——二者之间崩溃不可能留下「已物化但为空」的会话。 |
| 追加 | 每批一个事务；行上的 `revision` 计数器随提交递增。 |
| 撕裂尾巴 | IndexedDB 没有撕裂字节。撕裂尾巴即「已提交前缀未覆盖的行」：首个畸形行或 seq 空洞终止前缀；`loadStored` 只返回前缀外加 `tornMarker: { truncateFromSeq }`。 |
| 修复 | `commitRepair` 按 key 范围删除 `seq >= truncateFromSeq` 的事件行（JSONL 字节截断的 IDB 等价物），并在同一事务写入合成收尾事件。 |
| 版本号 | `SessionPersistenceRevision("indexeddb:<dbName>:<id>:<n>")`——不变时稳定，每次持久写入都会移动；以数据库名做来源限定。 |
| 定位读取 | events 存储按 seq 建键，因此 `loadStoredFrom` 只读 `seq >= fromSeq`（与 SQLite 一样的协调器后缀路径）。 |

读取（`loadStored`）返回 `structuredClone` 的图——头部与事件都与存储行 detach，准备阶段可以就地冻结并发布。

## 配置与注入

`Config` 接受 `dbName`（默认 `dsh-sessions`）以及协调器策略项 `preparedSessionCacheSize` 与 `writeBatchMaxDelayMs`（与其他协调器后端共享默认值）。`locate(meta)` 命名存储键前缀——`{ kind: 'indexeddb', path: '<dbName>/sessions/<id>' }`——且不触碰数据库。所有 IndexedDB 访问收敛到一个可注入的 `openDatabase` 工厂（默认：页面/worker 的 `indexedDB` 全局，schema version 1 创建两个存储），在没有全局对象的环境里每次存储调用都以 ``session-persistence-indexeddb：当前环境没有可用的 indexedDB 全局对象`` 失败。测试通过同一 `StructuredDatabase` 表面上的内存结构适配器驱动后端。

## 模型体验

无——后端只存储并服务持久会话状态：协调器的合成收尾事件（`step/end`、`turn/end {interrupted}`、可重试的工具错误）是仅有的日志变化，不注册任何 prompt、schema 或流。

#### KV Cache 影响

没有直接失效；经本后端的续接/历史读取只馈送到所组合 agent 已有的渲染。

## 已知限制与遗留工作

- **没有跨源/多 profile 方案** —— 每个组合一个数据库名；不应共享历史的分区扩展上下文需要不同的 `dbName`，且没有迁移来合并它们。
- **没有配额压力处理** —— IndexedDB 逐出或配额失败以追加路径的存储错误浮现；旧会话的保留/GC 策略推迟。
- **没有 `readRaw`** —— `supportsRawArtifacts` 为 `false`：行是结构化克隆而非每会话一个逐字产物，raw-artifact 消费者退回逻辑视图。
- **仅 schema version 1** —— 未来的存储变更必须提升 `DATABASE_VERSION` 并带升级路径；因不存在旧布局，暂未提供。

## 开发备注

本包为 fork 新增，随扩展发布节奏演进；接口变化时同步更新本页内容与目录。
