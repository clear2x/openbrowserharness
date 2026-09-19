# Agent Note: Edge 上的 tabs_reopen——sessions 权限与过期窗口 id

Status: implemented

[English](2026-09-19-tabs-reopen-edge-sessions.md) | 中文

## 问题

tabs_reopen 工具在 Edge 上崩溃，报「Cannot read properties of undefined (reading 'getRecentlyClosed')」：工具调用 `chrome.sessions.getRecentlyClosed`，但 manifest 从未声明 `sessions` 权限，Service Worker 里 `chrome.sessions` 是 undefined——这个工具从未可用过。补上权限后 Edge 又暴露第二层坑：`getRecentlyClosed` 对已关闭会话报出过期的 `windowId: 0`，而 `chrome.tabs.create({ windowId: 0 })` 会以「No window with id: 0」拒绝。

## 决策

manifest 声明 `sessions` 权限；reopenClosedTab 先按记录的窗口创建恢复的标签页，窗口 id 被拒绝时回退到默认窗口——Edge sessions API 给出的 id 是建议值而非权威值。

## 备选方案

- **不用 chrome.sessions，改为从扩展自己的会话日志重建关闭的标签页。** 否决：chrome.sessions 是最近关闭状态的平台数据源，还覆盖用户在 agent 之外手动关闭的标签页；基于日志的重建会漏掉这些。
- **把 tabs_reopen 从扩展工具面移除。** 否决：撤销关闭是 tabs 家族对等承诺的一部分，而修复只是两行回退。

## 后果

- tabs_reopen 在 Edge 与 Chrome 上均可用；过期记录的窗口 id 退化为在当前默认窗口打开恢复的标签页。
- 覆盖：综合真机 harness 在 tabs_close 之后驱动 tabs_reopen，并验证出现了承载该 URL 的新 tab id。
