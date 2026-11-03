---
description: "持久会话数据面：围绕核心会话服务的持久化、投影、标题与遥测。"
kind: "package-group"
---

# session/：持久会话数据平面

[English](README.md) | 中文

## Summary

这是围绕 `core/session` 内存中运行的服务构建的持久功能族：包括持久化 seam 及其存储后端和检查点策略、提供日志派生全量值的投影 seam、日志支持的标题，以及外发会话遥测。它们全部都是**产品**包（package）。`session-query/` 仍是同级独立组：读取／工具接口的消费不依赖持久化内部实现。

## 持久化

持久会话数据的持久化机制、语义检查点策略以及随产品交付的存储后端。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`message-quotes/`](message-quotes/README.zh.md) | 引用控件与 Markdown blockquote 渲染 | — |
| [`session-format/`](session-format/README.zh.md) | 纯相邻格式链与产物校验库 | 库，不使用 ctx key |
| [`session-format-v0-to-v1/`](session-format-v0-to-v1/README.zh.md) | 冻结的 released-v0 解码器，以及到 released v1 的恒等迁移 | 库，不使用 ctx key |
| [`session-format-v1-to-v2/`](session-format-v1-to-v2/README.zh.md) | 冻结的 released-v1 解码器，以及迁移到 released v2 时会改变基数的 Assistant 流迁移 | 库，不使用 ctx key |
| [`session-format-v2-to-v3/`](session-format-v2-to-v3/README.zh.md) | 冻结的 V2 解码器，以及迁入 V3 的系统提示词、信封与 PTC 转换 | 库——无 ctx 键 |
| [`session-format-v3-to-v4/`](session-format-v3-to-v4/README.zh.md) | V3 恒等迁移与 V4 编解码器，按 generation 校验 delivery | 库——无 ctx 键 |
| [`session-format-catalog/`](session-format-catalog/README.zh.md) | 自动生成的已交付相邻迁移静态目录 | 库，不使用 ctx key |
| [`session-persistence/`](session-persistence/README.zh.md) | 定义持久会话存储服务，以及每个后端组合的共享写入协调机制 | `ctx.sessionPersistence` |
| [`session-persistence-jsonl/`](session-persistence-jsonl/README.zh.md) | 随产品交付的后端：逐 Session 使用不可变规范 generation 文件名并排他发布后继；可选 Zstandard 压缩 | 注册到 `ctx.sessionPersistence` |
| [`session-persistence-indexeddb/`](session-persistence-indexeddb/README.zh.md) | 为浏览器／扩展宿主将会话持久化到 IndexedDB | 注册到 `ctx.sessionPersistence` |
| [`session-checkpoint-policy/`](session-checkpoint-policy/README.zh.md) | 让模型请求、顶层工具副作用与已完成步骤在下一步动作前持久化 | 包装 `ctx.llm` 与 `ctx.tools` |
| [`session-log-deepseek/`](session-log-deepseek/README.zh.md) | 把增量规范日志作为可选的官方 DeepSeek 请求元数据上传 | 贡献 `dsh_session_log` |

[会话持久化决策](../../.agents/notes/implemented/architecture/2026-06-14-session-persistence.zh.md)记录了持久化设计。

## 投影

向客户端载体提供从日志派生的当前逐会话状态。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`session-projection/`](session-projection/README.zh.md) | 定义并驱动把已提交事件折叠为完整当前值的投影单元 | `ctx.sessionProjections` |
| [`working-directory/`](working-directory/README.zh.md) | 拥有每个 Session 的有效执行目录和用户上下文变更 | `ctx.workingDirectory` |
| [`tool-working-directory/`](tool-working-directory/README.zh.md) | 通过一个工具读取或改变当前目录 | `working_directory` |
| [`session-projection-cache/`](session-projection-cache/README.zh.md) | 持久化投影检查点，使冷读跳过全量日志加载 | `ctx.sessionProjectionCache` |
| [`session-stats/`](session-stats/README.zh.md) | 通过 `sessionStats` 单元提供全日志会话计数与墙钟时间 | 注册到 `ctx.sessionProjections` |
| [`session-turn-outline/`](session-turn-outline/README.zh.md) | 通过 `turnOutline` 单元提供全日志轮次大纲（轮次、`turn/start` seq、提示词预览） | 注册到 `ctx.sessionProjections` |

## 标题

从会话日志派生持久会话标题，并支持可选的模型驱动提供方。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`session-title/`](session-title/README.zh.md) | 基于日志的会话标题，带确定性回退与一个可选提供方 | `ctx.sessionTitle` |
| [`session-title-llm/`](session-title-llm/README.zh.md) | 为提供方自有的标题策略提供的共享有界执行 | 库，不使用 ctx key |
| [`session-title-first-prompt-llm/`](session-title-first-prompt-llm/README.zh.md) | 根据第一条合格的人类消息为会话生成标题 | 注册到 `ctx.sessionTitle` |

部署可以注册一个模型驱动提供方；未注册时，服务仍保留确定性回退机制。

## 遥测

将会话活动投影为外发遥测，并将投递委派给配置的上报后端。遥测决策记录上报边界；模式决策记录即时、反馈门控与禁用投递。

| 包 | 职责 |
|---|---|
| [`session-telemetry/`](session-telemetry/README.zh.md) | 定义捕获、脱敏、投影，以及实时或按需后端投递。 |
| [`session-telemetry-otel/`](session-telemetry-otel/README.zh.md) | 通过 OpenTelemetry 日志以 `FULL`、`FEEDBACK_ONLY` 或 `DISABLED` 模式投递遥测。 |

<a id="related-documentation"></a>
## 相关文档

- [会话持久化子系统](../../docs/subsystems/persistence.zh.md)——后端无关的服务语义、flush 检查点与崩溃恢复。
- [工作目录子系统](../../docs/subsystems/working-directory.zh.md) — 有效目录与恢复。
- [会话投影子系统](../../docs/subsystems/session-projection.zh.md)——投影单元约定与驱动语义。
- [会话标题子系统](../../docs/subsystems/session-title.zh.md)——标题资格、回退与提供方流程。
- [会话遥测子系统](../../docs/subsystems/session-telemetry.zh.md)——捕获、脱敏与投递模式。
- [会话子系统](../../docs/subsystems/session.zh.md)——本组每个包持久化或派生的实时事件日志。

实验性可选能力见 [`session-title-all-prompts-llm`](../experimental/session-title-all-prompts-llm/README.zh.md)。

<a id="dev-note"></a>
## 开发备注

无。
