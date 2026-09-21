# Agent Note：回车直接发送；输入法合成守卫挡住候选词上屏的回车

Status: implemented

[English](2026-09-22-ime-enter-send.md) | 中文

## 问题

输入框只在 Cmd/Ctrl+Enter 时发送；裸回车永远是换行。中文输入的动线变成：打拼音、回车上屏候选、继续打字、打完之后还得挪鼠标点发送——最自然的最后一记回车什么也不做。用户要求对齐 ChatGPT 惯例：回车发送；输入法合成期间回车只上屏候选、绝不发送。

## 决策

输入框 keydown 改为无 Shift 的 Enter 即发送（裸回车、Cmd+Enter、Ctrl+Enter 都发送；Shift+Enter 保持换行），守卫由两个信号组成：keydown 事件的 `isComposing`，加上 `compositionstart`/`compositionend` 维护的 ref——后者覆盖提交候选的 keydown 与 compositionend 事件竞态的引擎。任一信号存活时 Enter 原样放行（输入法自行上屏候选，composer 不插换行）。Esc 中断保留合成守卫。占位符与 composer 提示文案更新为「Enter 发送，Shift+Enter 换行」。内联菜单的按键处理本就有同样的合成放行，未动。

## 考虑过的替代

- **维持 Cmd/Ctrl+Enter 为唯一发送。** 否决：这正是用户明确要改的行为；合成守卫移除了裸回车不安全的唯一理由。
- **改在 keyup 发送以增强输入法兼容。** 否决：keydown 的 `isComposing` 加合成 ref 就是 Chromium 上的标准稳健组合；keyup 发送手感发粘，还破坏 Esc 中断的对称性。

## 后果

- 英文输入：回车立即发送；Shift+Enter 换行。
- 中文输入：回车上屏候选（输入法自理，不发送）；合成结束后下一记回车发送。
- 覆盖：真机装置合成一段输入法会话（compositionstart → `isComposing=true` 的 Enter keydown → compositionend）并断言 mock LLM 零请求，再按真实回车断言发送与回复返回。扩展全量、typecheck、lint 全绿。
