# Agent Note: Edge 调试器重新认领——会话目标 id 归属探针

Status: implemented

[English](2026-09-19-edge-debugger-ownership.md) | 中文

## 问题

chrome.debugger 的附加状态存在两处：浏览器层（除非标签页关闭否则一直存活）和 Service Worker 内存里的 `attachedTabs` 集合（每次 MV3 SW 闲置重启即丢失）。针对这一分裂的自愈逻辑——attach 报「another debugger」时，若 `chrome.debugger.getTargets()` 显示持有者是我们自己的扩展则认领——以 `target.extensionId` 为判据。而 Edge 的 `getTargets()` 在所有条目上都省略 `extensionId`，探针因此永远认不出自己的 attach：SW 重启后的第一个工具必报「无法附加调试器：该标签页已被其他调试器占用」，且同标签页后续工具持续失败直至标签页关闭。真实会话掩盖了它（打开的面板让 SW 保持存活），但内存压力下 SW 一旦被杀，整个会话的页面工具即全部失效。

## 决策

归属判定改用记录下来的会话目标 id。每次成功 attach（以及每次自愈认领）后，控制器快照 `getTargets()` 并把该标签页所附加目标的稳定会话 `id` 存入 `chrome.storage.session`——它能在丢失内存 Map 的 SW 重启后存活。认领探针在两种情况下通过：Chrome 式 `extensionId` 匹配（Chrome 上仍走此路），或记录的 id 指向仍然附加着的目标；detach 与 onDetach 事件清除记录。同一批次中，composer 各芯片补齐了菜单早已具备的 `aria-label`（选择模型 / 上下文用量 / 权限模式 / Agent 预设）——此前只有思考强度和发送按钮能被辅助技术看到，这也让 AX 驱动的验证对其余工具栏视而不见。

## 备选方案

- **当该标签页唯一的附加调试器目标缺少 `extensionId` 时直接认领。** 否决：在 Edge 上第二个扩展的附加与之完全一样，对外来调试器的响亮报错保证随之丢失。
- **改为保持 Service Worker 不死。** 否决：面板已经在附带地做这件事，但控制器必须按设计扛住 SW 重启——与看门狗为 offscreen 文档已覆盖的分裂是同一类问题。

## 后果

- Edge 上会话中途 SW 重启不再使页面工具失效：下一个工具重新认领被持有的会话并继续；Chrome 上行为不变。
- 外来调试器的附加仍然响亮失败——不同的持有者呈现的会话目标 id 与记录值不同。
- 覆盖：综合真机 harness 驱动发布构建跑完 click/type/scroll/evaluate 轮次，轮次之间的 mock 间隔长于 SW 闲置窗口；修复后每个重启后的工具都真实执行，修复前它们全部以占用错误失败。
