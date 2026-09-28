# Agent Note: GoalBar dock——原生 shell 从未声明 `main` 槽

Status: implemented

[English](2026-09-28-goalbar-dock-main-slot-declaration.md) | 中文

## Problem

能力面板（goal bar、todo strip、queue——docked conversation 槽家族）在扩展里从未渲染：模型执行的 `create_goal` 成功了，`[data-goal-bar]` 却从不出现，`.dshx-caps` 一直不挂载。唯一的控制台线索是长期存在的 `AgentPresetSeatController` 报错 `cannot get required service "sessions" in inactive context`，此前批次把它当成无害残留。

## Decision

扩展 shell 的根注册补上了缺失的槽声明。桌面根框架（`ui-layout`）在 children 里声明 `'main': { kind: 'keyed', scope: 'root' }`；`ui-conversation` 把整个会话槽家族门在 `slots.inject('main', …)` 后面——那个 prepare 注册 `main.conversation` 的 children 表，而 `conversation.input.dock`（goal/todo/queue dock）正是在那张表里声明的。原生 shell 用自己的 `root` register 替换了框架，children 表漏了 `main`，注入便永远等待一个不会出现的声明：`registerConversationRoot()` 不跑、`conversation.input.dock` 不声明、`ui-goal` 的 dock prepare 不触发，所有 dock 熄灯——而引擎侧 goal 一切正常。

修复就是 shell 的 root children 表里那一行声明，外加说明框架替换历史的注释。`ConversationPanel`（桌面的 `main` occupant）有意保持不渲染——shell 直接渲染 `ConversationRoot`，而 ConversationRoot 自己放置 input.dock 系 dock（`renderSlot('conversation.input.dock', zone)`）。

## 根因定位方法（供下一个死槽调查复用）

真机 harness（`~/obh-test/goalbar-probe.mjs`）插桩复现：mock 驱动 `create_goal`，再经 `ui-goal` 与 `ui-renderer/registry.ts` 的 console 插桩读 slots 系统。决定性轨迹：启动时 `conversation.input.dock declared: false` 三次（ui-goal 的 inject effect 在等），补上声明后出现 `declared: true` 与 `PREPARE RAN — registering input.dock occupant`。经 shell dump 的 fiber 状态证明插件一直是 ACTIVE（state 2、无等待服务）——这推翻了第一轮调查的「boot 激活竞态」假设。

过程中两个测量陷阱产生过假的「缺席」读数：诊断 `console.info` 已从源码移除而探针仍在 grep 它们；探针的管道 stdout 缓冲到退出才输出。插桩断言必须对照构建产物复核（grep dist chunk），探针必须边跑边把日志落文件。

## Alternatives considered

**修 loader 对 `immediately: false` 插件的激活语义。** 此时否决：插件是 ACTIVE（fiber state 2、无等待服务）——激活从来不是问题，动 vendored/上游语义不会有任何效果。

**shell 侧重试重新注册 dock occupant。** 否决：shell 无法替别的插件重跑 prepare（goal dock 的动词绑定 ui-goal 自己的 sessions/remote 面），而对活着的 slots.inject 做重试按设计是幂等空操作。

**shell 直接渲染 GoalBar。** 否决：goal bar 的动词（带 CAS ref 的 edit/pause/resume/clear）是 ui-goal 的注入业务面；shell 复制一份会分叉这套接线，偏离桌面的 dock 契约。

## Consequences

能力面板现在渲染（composer 上方出现可折叠的 能力面板 条），dock 随数据点亮：探针里模型创建的 goal 展示了 goal 系统的轮次运行。GoalBar 对已完成的 goal 有意不渲染——探针的 mock（重复最后响应）把 goal 推到轮次上限，截屏时刻 bar 缺席是设计内空态，不是缺陷。`AgentPresetSeatController` 的 sessions inactive-context rejection 在 boot 期仍会出现；现已确认它对本表面无害，但其自身根因仍未关闭。`main` 声明同时意味着 `ConversationPanel` 有了一个可注册的 occupant key 而 shell 有意不渲染它——日后任何接线 `renderSlot('main')` 的人必须与 shell 的 ConversationRoot 直渲染路径对账。
