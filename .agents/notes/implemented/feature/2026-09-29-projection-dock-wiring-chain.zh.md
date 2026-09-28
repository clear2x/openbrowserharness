# Agent Note: 投影 dock 端到端——引擎折叠到 dock 点亮之间的四道缺口

Status: implemented

[English](2026-09-29-projection-dock-wiring-chain.md) | 中文

## Problem

`main` 声明落地后（见 [2026-09-28-goalbar-dock-main-slot-declaration](2026-09-28-goalbar-dock-main-slot-declaration.zh.md)），能力面板挂载了却是空的：模型执行的 `todo_write` 落库成功、mux tap 显示 `session/projection` 帧到达，`[data-testid="todo-panel"]` 依旧从不出现。探针还顺带暴露了第二个不相干缺陷：整个 SidePanel 每秒重渲染数千次。

## Decision

按断点顺序的四道缺口：

**1. shell 渲染了错误的槽。** shell 渲染的是一个没有 occupant 的 `conversation` 锚点；会话面板注册在 `main` keyed 槽的 `conversation` 键下（桌面 `ui-layout` 经 `renderSlot('main', {}, { entryKey })` 渲染它）。shell 的两处 dock 挂载点改为 `renderSlot('main', {}, { entryKey: 'conversation' })`，并在它自己的 `SlotMap` 增强里声明 `'main': { kind: 'keyed'; scope: 'root' }`——声明注册器拥有契约；引入 `ui-layout` 的增强不是选项（该包被扩展 roster 刻意排除）。类型注记：register 重载组合 `keyof ChildrenDecl & keyof SlotMap`，增强进入扩展程序之前组件无法声明 `renderSlot('main')`。

**2. workspace 共享座缺失。** `ConversationRoot` 从桌面 `ui-workspace` 安装的根钩子座读 `useWorkspaces`；roster 排除了 `ui-workspace`，于是 `main.conversation` 以 `useWorkspaces is not a function` 崩溃。shell 现在自己供给这个座，用的是其 inject 已声明的 `workspaces` 服务：`ctx.slots.provideRoot({ hooks: { workspaces: workspaces.list } })`。

**3. wire 标签与会话契约永远对不上。** mux 载 `session/projection`；`ClientSessions.handleControlFrame` 按 `projection` 分派——原始帧落进 queue 分支静默死亡。connection 模块的 tap 现在把帧归一化为控制帧臂再发 `mux/projection`。相关陷阱：用 `@deepseek-ai/dsh-session` 给该帧标类型会把该模块冲突的 `Context.sessions` 增强（`SessionStore`）带进客户端程序并翻转合并胜者——帧字段类型现在从 `Extract<SessionControlFrame, { type: 'projection' }>` 派生。

**4. 会话桥假设了一条从未运行的推送腿。** `useSessionBridge` 等「新建会话 id 经 host 流落进 `sessions.list`」——扩展不跑 host 流，而服务自己的拉取（`refresh()`）经 typert remote 解析后落不下行。桥现在把普通 `session.list` rpc 的行经 `handleSessionAdded`（远端通知的同一个处理器）喂进服务再 `open(id)`；没有当前会话时，所有 session 作用域槽都不解析，dock 永不挂载。

## 渲染风暴是另一处既有循环

插桩渲染计数显示 `ExtensionShell` 从 boot 起每秒重渲染 2–4k 次——早于任何 dock 挂载。根因：`useTabs` 每次渲染重建 `refresh`，以其为键的 effect 每次提交都重跑，而每轮 `queryTabs().then(setTabs)` 都交回新数组——被 rpc 往返速度驱动的自持循环。`refresh` 现为 `useCallback` 稳定引用。dock 自身渲染率从值变化间 ~108,882 次降到 9 次。能力面板挂载只是暴露了它；循环早于 dock 存在。

## Alternatives considered

**保留裸 `conversation` 锚点，由 shell 直接向它注册 occupant。** 否决：dock 的动词（goal 编辑/暂停、todo 折叠）绑定 ui-goal/ui-conversation 的注入业务面；shell 重新注册会分叉这套接线，偏离桌面 dock 契约。

**会话桥改轮询驱动客户端会话名单。** 否决：shell 头部已按 20 秒节奏轮询 `session.list` 供自己的菜单使用；桥里再轮询会加倍 rpc 流量，而桥只需要每次选中时的一份状态。

**渲染风暴留给专门的性能批次。** 否决：每秒 2–4k 次渲染让已挂载的 dock 在每个投影帧之间做无用重渲染，直接污染本次排查依赖的渲染计数测量；一行 `useCallback` 修复比绕开测量便宜得多。

## Verification

真机探针（`~/obh-test/todo-probe.mjs`、`goalbar-final.mjs`）：mock 驱动 `todo_write` → `[todo-panel count] 1` + `PASS TodoDock rendered`；mock `create_goal` → `[goal-bar count] 1` + `PASS GoalBar rendered with goal`，能力面板正文携带目标文本。值得保留的测量陷阱：引擎的 `todos` 折叠在下一个 `turn/start` 清空（turn/end 保留已完成的清单），所以采样前重发的探针按设计读到空 dock——要在活回合窗口内采样。

## Consequences

dock 家族（goal bar、todo strip）从活投影端到端渲染。遗留已知噪音：每个 mux 帧投递两次（port 派发 tap 与流迭代器各交一次）——对 store 按 seq 幂等，但值得合并；`AgentPresetSeatController` 的 inactive-context 拒绝仍在 boot 期出现，保持开放。单测套件里 corner-shape 配对、tool-catalog 漂移与 typert catalog 覆盖的失败在干净树上复现，属于 catalog 债而非本批改动。
