---
description: "供维护者与后端作者使用的薄型进程内 subagent 运行入口：经激活管理器启动一次性进程内子 agent。"
kind: "package-library"
---

# @deepseek-ai/dsh-subagent-in-process-driver

[English](README.md) | 中文

## 概述

`dsh-subagent-in-process-driver` 是进程内 subagent 调用方经激活管理器启动子 agent 的薄型一次性入口：`startInProcessRun(request, options)` 把调用方侧的启动请求转发给 `ctx.subagents.startActivation`（所选可续接提供方、caller 投递），并把激活回执映射为一次已发布的运行。子 agent 物化、提示词投递、结算捕获、结构化输出、委派策略继承与资源释放都归管理器所有；本包自身不增加任何生命周期。它是库而非独立功能：直接调用方调用 `startInProcessRun`，组合中没有任何东西配置它。阅读本页可理解直接调用方收到的运行形态。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

你通过直接调用方而非组合到达本包。随附的进程内后端（`dsh-subagent-spawn-in-process`、`dsh-subagent-fork-in-process`）以提供方身份参与：它们的 `prepareContinuable` 提供创建初始内容，其余全部由激活管理器完成。本页记录直接调用方收到的运行形态。

### 一次运行提供什么

一次调用启动一个 caller 投递的子 agent。调用兑现意味着管理器已把子 agent 发布到 `ctx.agents` 并保留其激活；运行暴露子 agent 的 id 与在线 agent、管理器持有的 `result` promise，以及激活的 `dispose()`。结算包含释放：管理器在自然结算时释放子 agent，因此 `result` 兑现即表示子 agent 已不在注册表中，随后的 `dispose()` 是共享的空操作。在结算前调用 `dispose()` 则会取消子 agent。

### 唯一输入

`InProcessRunOptions` 的形态为 `{ provider?: string }` ——已注册的 `ctx.subagents` 提供方名称，默认 `spawn`。

### 子 agent 获得什么

一切都由管理器解析：除非 `request.agentOptions` 覆盖，子 agent 继承父级的生效路由与输出 token 上限；获得委派的沙箱覆盖项与 `'never'` 审批钉定、subagent 描述符、请求的工作目录；当设置 `request.outputSchema` 时，获得 seam 的结构化输出运行时，其捕获值以 `SubagentResult.structured` 到达。`prepareContinuable` 返回初始内容的提供方会附加父级历史前缀。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释映射约定；可观察行为已在[使用本包](#use-this-package)中说明。

### 启动约定

入口按以下顺序运行：

1. 从父级的上下文解析 subagent 运行时；缺失即响亮失败，报 `CONTINUATION_UNAVAILABLE`。
2. 以 caller 投递、所选提供方，以及请求中可选的 cwd、preset、agent 选项、输出 schema 与深度上限，把请求转发给 `startActivation`。seam 在发布前校验能力、深度与取消；被拒绝的启动不会发布任何东西。
3. 从 `ctx.agents` 读出已发布的子 agent，连同激活的结果与释放一起返回。

### 取消与所有权

必需的请求信号覆盖启动直到收件箱接受；接受之后，调用方经 `dispose()` 取消——它停止子 agent、等待完全停稳并释放激活。清理失败会让 `dispose()` 拒绝，但不替换已捕获的结果。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 启动映射：运行时解析、`startActivation` 转发、回执到运行的形态 |
| — | 不发布运行时不变式伴生入口；本包没有独立事件序列或可变数据关系，相关约定在所属 seam 强制执行。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面；它们从本入口进入拥有生命周期的 seam。

- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——启动请求、结果、提供方约定与激活所有权。
- [dsh-subagent-spawn-in-process](../subagent-spawn-in-process/README.zh.md)——全新子 agent 提供方。
- [dsh-subagent-fork-in-process](../subagent-fork-in-process/README.zh.md)——带初始内容的子 agent 提供方。
- 委派策略决策——父级沙箱与审批策略如何到达子 agent。

-----

<a id="model-experience"></a>
## 模型体验

### 子 agent 请求

#### 模型看到什么

管理器把任务逐字作为子 agent 的初始用户消息发送，追加 subagent 描述符与委派策略事件；对结构化运行，还会加入 seam 的 `structured_output` 定义与指令。caller 投递的运行从不通知父级；调用方只从结果读取最终输出与捕获值。

#### Token 影响

子 agent 输入与父级隔离，并随子 agent 自身的步骤增长。结构化指令与 schema 的开销仅由该子 agent 承担。

#### KV Cache 影响

与父级请求缓存相互独立。子 agent 后续历史从自身前缀开始仅追加。

### 父级启动错误（间接）

#### 模型看到什么

经 seam，无效深度或能力请求会变为运行时的类型化 `SubagentError` 文本；发布前取消会拒绝且不发布子 agent。

#### Token 影响

启动成功时为零 token；只有失败的父级工具调用会保留这段文本。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明进程内一次性运行不能做什么；它们是当前包约束。

- **仅支持 caller 投递**——运行从不向父级发送结算通知；需要前台投递的宿主应经 seam 以 parent 投递启动。
- **可续接物化**——管理器以可续接描述符物化子 agent；旧的 one-shot 描述符形态不再写入。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
