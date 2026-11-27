# 文档地图

[English](../README.md) | 中文

本页是 `docs/` 树的导航索引。核心入口：[架构总览](architecture.md)、[开发流程](development.md)、[测试策略](testing.md)。

## 入门与日常

- [开发流程](development.md)：工作区命令、TypeScript 项目布局、发布检查。
- [测试策略](testing.md)：单元/快照/端到端分层与运行方式。
- [术语表](glossary.md)：全仓共享的领域词汇。
- [Cordis 入门](cordis-primer.md)：插件系统的核心概念与加载语义。

## 架构与机制

- [架构总览](architecture.md)：分层、能力缝与目录地图。
- [Agent 生命周期](agent-lifecycle.md)（生成）：从输入到会话事件的完整路径。
- [能力缝](capability-seams.md)（生成）：Service Definition/Provider/Consumer 三角色。
- [事件生产与消费](event-producer-consumer.md)（生成）：总线事件域与投影。
- [工具执行管线](tool-execution-pipeline.md)（生成）：工具调用的执行与审批路径。
- [CLI 帮助](cli-help.md)（生成）：启动器与子命令的完整帮助。

## 参考目录

- [配置目录](config-catalog.md)（生成）：全部可配置项及其校验。
- [工具目录](tool-catalog.md)（生成）：全部内置工具的声明与文档。
- [持久化目录](persistence-catalog.md)（生成）：Session 事件与类型清单。
- [实验性插件记录](experimental-persistence-catalog.md)（生成）。
- [模块图](module-graph.md) 与 [关系图谱](graph-atlas.md)（生成）。
- [子系统参考](../subsystems/zh/README.md)：按子系统划分的逐包说明。

## 专题

- [Session 格式状态](session-format-status.md)：当前写入器版本与兼容基线。
- [持久化变更记录](../persistence-changes/zh/README.md)：类型变更的确认历史。
- 升级指南：`../upgrade-guide/` 目录按 `v<版本>/<条目>/guide.md` 组织跨版本迁移操作。
- [双语文档约定](../i18n/zh/README.md)：配对、门禁与排除规则。
- [防御式模式](../defensive-patterns/zh/README.md)：包面/远端服务/客户端组件的审查原则。
- [术语与翻译规则](../i18n/terminology.md)：双语术语真源。
- [复刻上游（rescope）](rescope.md)：vendor 重 scoped 的发布序列规则。

## 用户指南（继承的桌面形态）

- [使用 Web UI](../user/guide/zh/index.md)：继承自上游的桌面 Web UI 使用说明。
- [Python SDK](../user/guide/zh/python-sdk.md)：Python 侧启动与示例。
