# OpenBrowserHarness（openbrowserharness-extension）

[English](README.md) | 中文

DeepSeek Harness 的 Chrome MV3 扩展宿主：完整的 dsh agent loop（Cordis 微内核、事件溯源会话、工具运行时、LLM 适配器）**完全在浏览器内运行**，长驻于 Offscreen 文档——无需任何 Node 进程。

## 这是什么

- **插件形态的 dsh** —— 与 Node 宿主相同的插件包，以浏览器方式引导（`new Context()` + Loader 静态模块映射，不读 yml 文件）。
- **长时间运行** —— 引擎驻留 Offscreen 文档；会话事件溯源持久化到 IndexedDB（`dsh-session-persistence-indexeddb`，含崩溃修复），预配置的 `main` agent 携带稳定会话身份，Offscreen 被重建后自动恢复同一会话。Service Worker 的 alarms 看门狗在 Chrome 回收 Offscreen 后重建引擎宿主。
- **浏览器能力即 dsh 工具** —— `dsh-tool-browser` 在 `ctx.browser` seam 上暴露 `tabs_*` / `page_*` 工具；扩展 provider 用 `chrome.debugger`（CDP）驱动拟人化输入：三阶贝塞尔鼠标轨迹、随机化击键节奏、穿透 Shadow DOM/iframe 的页面快照。
- **可见的虚拟指针** —— CDP 输入不移动系统指针，因此每个手势同时在页面内渲染 overlay：跟随真实派发坐标的指针箭头、渐隐轨迹与点击涟漪（见[虚拟指针 Agent Note](../../.agents/notes/implemented/feature/2026-08-20-visible-virtual-cursor.zh.md)）。

决策记录（shim 策略与被否决的替代方案）见[架构 Agent Note](../../.agents/notes/implemented/architecture/2026-08-19-browser-extension-host.zh.md)。

## 目录

| 路径 | 职责 |
| --- | --- |
| `src/background/` | Service Worker：CDP 控制器（贝塞尔鼠标、键盘仿真、穿透快照）、标签页操作、消息路由、Offscreen 看门狗 |
| `src/offscreen/` | 引擎宿主：浏览器式 boot + 插件组合 + 自动恢复 |
| `src/chrome/` | 扩展原生 dsh 插件：`chrome-credentials`、`chrome-llm`（基于 chrome.storage 的 DeepSeek 适配）、`chrome-browser-provider`、`ui-bridge` |
| `src/sidepanel-dsh/` | 真 dsh Web UI boot（静态清单、平台种子、PortApiClient 载体） |
| `src/sidepanel/` | 挂载 dsh web 壳到 `#root` 的薄入口 |
| `src/shims/` | 被挂载闭包触碰的 node: 内建的最小浏览器 shim（`async_hooks` ALS 空实现、`crypto`、`path`、`util`、`module`、`process` 全局） |
| `src/shared/protocol.ts` | 跨上下文消息契约（UI 端口、CDP 通道、agent 通道） |

## 构建与运行

```sh
# from repo root (workspace libs must be fresh)
pnpm install
pnpm run build:lib
pnpm run build:extension
```

在 `chrome://extensions` 以「加载已解压的扩展程序」方式加载 `apps/extension/dist/`。点击工具栏图标打开 SidePanel，在设置中填入 DeepSeek API Key 即可对话。首次对某个标签页执行自动化会附加 `chrome.debugger` —— 浏览器顶部的「正在调试此浏览器」提示条是该 API 的固有行为。

## Known Limitations and Deferred Work

- **模型/Base URL 变更只对新会话生效** —— 预配置的 `main` agent 在组合时固化其路由。
- **Node 专属工具族未挂载**（bash/fs/shell/subagent/workflow/…）—— 浏览器闭包只组合 loop、todo 与浏览器工具。
- **SidePanel 就是 dsh Web UI** —— 完整客户端技术栈静态 boot、经 Port 载体连 offscreen 引擎；宿主专属面（目录选择、goal/预设编写、内容搜索）以结构化 `not-available-in-extension` 错误应答而非渲染。要求 Chrome ≥134（被挂载闭包含 `using` 声明）。
- **虚拟指针 overlay 仅存在于顶层框架** —— 进入同源 iframe 的手势派发正确，但绘制的指针是顶层视口投影。
