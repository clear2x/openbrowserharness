# Agent Note：设置面的 Agent 预设页签说的是桥从未应答的桌面 wire 名

Status: implemented

[English](2026-09-21-agentpresets-desktop-aliases.md) | 中文

## 问题

设置面的 Agent 预设管理页签每次打开都报 `此方法在扩展宿主中不可用：agentPresets/list`，而 composer 的预设芯片列的却是同一份名册。两个面说的是两套 wire 词汇：composer 的面板代码调桥的点式方法（`agentPreset.list`…），而 dsh 设置 UI（与桌面共用）驱动复数斜线风格的 remote 名（`agentPresets/list`、`agentPresets/read`、`agentPresets/select`、`agentPresets/copy`、`agentPresets/deletePreset`）加桌面载荷键——相邻的两个设置调用（`settings/canOpenAgentPresetDirectory`、`settings/openAgentPresetDirectory`）同样未实现。页签需要的一切服务端早就有了，只是名字不同。

## 决策

桥在处理器表之后注册斜线风格别名：`list`/`read`/`select` 原样转发；`copy` 和 `deletePreset` 经一个别名辅助函数把桌面的 `id` 载荷键重映射到 composer 的 `agentPreset` 键（目标消失即响亮失败）。点式的 `agentPreset.list` 视图补上 `modeSelectionEnabled: true`——composer 确实对新/空白会话暴露预设选择，与设置模式开关所门控的是同一事实。名册视图本就带着完整 `AgentPresetRow` 形状（`id`/`trust`/`isDefault`/`name`/`description`/`broken`），设置页的默认预设写（对 `agent-presets` 命名空间的 `settings.update`）本就与 `storedDefaultPresetId` 往返互通，所以默认选择器无需更多桥工作即端到端可用。`settings/canOpenAgentPresetDirectory` 应答 `false`（无本地文件系统——揭示入口保持隐藏），`settings/openAgentPresetDirectory` 转发给既有的 reveal-path 处理器。

## 考虑过的替代

- **把 composer 的方法改名成桌面名。** 否决：面板代码、其 spec、座位/标签存储全部键在点式名上；改名是一份换一份的折腾，还有反向弄坏的风险。
- **用复制的名册逻辑实现斜线方法。** 否决：两份名册组装会悄悄漂移；别名只留一份实现，外加载荷键适配。

## 后果

- 设置的 Agent 预设页签加载真名册（内置行、默认、用户副本），支持经桌面名的复制/删除，其默认预设写往返进新会话组合。
- 覆盖：扩展全量、typecheck、lint 全绿；真机装置打开设置面、切到 Agent 预设页签、断言名册渲染（网页研究员/购物比价员/页面调试手/默认）且无不可用拒绝。
