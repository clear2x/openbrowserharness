# Agent Note: 扩展 mux 只运投影丢了 queue 帧——恢复 queue dock 的三道缝

Status: implemented

[English](2026-09-29-mux-queue-frames.md) | 中文

## Problem

扩展的 QueueDock 从不渲染：回合运行中发送的消息被接受（本地回显、无报错），引擎也把消息 durable 地 splice 进 inbox 并 claim 了——但排队条从未点亮。桌面 web UI 的 queue 行来自 typert 控制流；扩展的传输层从未承载它。

## Diagnosis

真机帧级 tap 清单：mux 流大量投递 `session/projection` 帧（todos/goal/plan/title/inbox），**零 `session/queue` 帧**。引擎侧健康——`agent/inbox/spliced` 事件在 durable 日志里成对出现（insert+claim）。三道互不相干的缝各自丢弃或饿死了 queue 臂：

1. **SW 侧投影桥只发投影。** `chrome-api-bridge` 把 `sessionProjections.onChanged` 扇出为 `session/projection` 帧；inbox 投影（`SessionControlController` 对等物里 queue 帧的触发器）不产生 `session/queue` 帧，`MuxFrame` union 甚至没声明它。
2. **panel 侧 tap 只路由投影。** `connection-module` 把 `session/projection` 归一化为控制帧臂，而 `session/queue`/`session/jobs` 被直接丢在地上。
3. **客户端 manager 的 queue 分派用了裸 Map。** `handleControlFrame` 的 queue 分支调 `this.sessions.get(id)?.handleControlFrame(frame)`——裸 `Map.get` 在帧先于会话实例到达时落空（投影臂用 create-on-demand store 绕开了这个问题）。与 session 桥竞速的 queue 帧因此只更新了 `manager.queues`，dock 读的实例 mirror 从未收到。

## Fix

- `chrome-api-bridge`：inbox 投影现在同时发 `session/queue` 帧（wire `QueuedInboxItem` 由活 inbox 视图折叠——next-turn 为 queued、用户 next-step 为 steering），`MuxFrame` 声明该臂。
- `connection-module`：tap 把三个 wire 臂（`session/projection`、`session/queue`、`session/jobs`）全部归一化为 `SessionControlFrame` 标签并统一发 `mux/control` 事件。
- `ISessions` 新增 `applyControlFrame`（委派 `manager.handleControlFrame`）；shell 的 mux 监听切换过去。
- manager 的 queue 分支改为懒建会话实例（`this.get(id)`）而非裸 Map 读。

## Verification

带插桩 apply 的真机探针：第二条消息的 queue 帧到达、应用，实例快照读到 `rows=1 placements=["queued"]`——数据路径端到端。dock 的可见窗口在 mock 场景下天然亚秒（运行中的回合在下一个 step 边界就 claim 了 followup，紧随一条空替换帧），所以探针断言的是 apply 后的快照而非 DOM 计数。沿用投影批次的帧类型陷阱：字段类型从 `Extract<SessionControlFrame, …>` 臂派生——从引擎面导入会翻转 `Context.sessions` 增强合并。

## Consequences

queue dock 与后续任何 jobs 面现在都收得到活帧。双重派发（port tap 与流迭代器都交一份 mux 封套）保持开放——按 seq 幂等但值得合并。plan 芯片真机复验挂起：探针环境的 Edge 启动在本批次中途劣化（与代码无关）；plan 投影走的是本批已端到端验证的同一投影通道。
