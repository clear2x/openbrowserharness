# Agent Note: dsh agent loop 以 Chrome MV3 扩展宿主形态交付

Status: implemented

[English](2026-08-19-browser-extension-host.md) | 中文

## 问题

dsh 的 agent loop 此前只运行在 Node 宿主内（`dsh web` / `dsh --profile headless`）：浏览器侧只是 UI 客户端。要让 harness *以浏览器扩展的形态*运行——引擎在页面进程、浏览器标签页即自动化操作面、无需 Node 进程——需要决定 Node 形状的闭包如何映射到浏览器运行时，以及扩展的长时间运行保证来自哪里。

## 决策

**`apps/extension` 以浏览器方式引导工作区插件包；Node 面通过打包器 shim 桥接，而不是修改任何包。**

- 引导镜像 web 客户端的模式（`packages/client/web/src/boot.ts`）：`new Context()` → `ctx.plugin(Loader)` → 用**静态模块映射**（包名 → namespace import）替代 `app-boot` 的 yml 文件组合。没有 `cordis.yml`，没有 `!!js`。
- 挂载闭包等价于 headless 组合：timer、llm、llm-retry、session、session-persistence-indexeddb、session-checkpoint-policy、token-meter、compaction-basic、tools、system-prompt、agent、agent-default-model、agent-loop、tool-todo、tool-browser，外加四个扩展原生插件（`chrome-credentials`、`chrome-llm`、`chrome-browser-provider`、`ui-bridge`）。
- 闭包内少量 `node:` 导入（`async_hooks` 的 AsyncLocalStorage 用于 initiator 归因、`node:crypto` randomUUID、`node:path` isAbsolute、`node:util`(types) 深比较、`node:module` createRequire、`process` 全局）由 **vite 别名指向 `apps/extension/src/shims/` 下的最小 shim** 满足。ALS 降级为空实现（归因回退为「未知 initiator」）；其余在浏览器有精确等价物。
- **LLM**：`llm-deepseek` 的*插件入口*拖着两个 Node 侧 peer（launch-environment、anonymous-user-id），因此扩展直接从其 `src/adapter.ts` 子路径导入 `DeepSeekAdapter` 注册，`resolveApiKey` 经由 `CredentialProvider` 实现从 `chrome.storage` 读取 `DEEPSEEK_API_KEY`——保留了逐请求解析语义。
- **长时间运行**：会话经新的 IndexedDB `PersistenceBackend`（`packages/session/session-persistence-indexeddb`）在共享的 `PersistenceCoordinator` 下持久化，继承撕裂尾部修复与合成关闭器；预配置的 `main` agent 携带稳定 `sessionId`，Offscreen 重挂载后恢复既有会话；SW 内 `chrome.alarms` 看门狗在 ping 超时后重建 Offscreen 文档。
- **浏览器能力**遵循 seam/provider/consumer 拆分：`packages/browser/browser`（ctx.browser）、`packages/browser/tool-browser`（12 个模型工具）、provider 在扩展内实现（`chrome.runtime` 消息 → SW 的 `chrome.debugger` CDP，拟人化贝塞尔/击键输入与穿透 Shadow DOM/iframe 的快照）。

## 曾考虑的替代方案

- **改 `core/agent` 移除 AsyncLocalStorage** —— 否决：打包器级 shim 对已交付包零改动；归因损失可接受且可逆。
- **把 `app-boot`（yml 读取、profile 组合）移植进浏览器** —— 否决：静态模块映射是更小、可审计的面；profile 是 Node 启动概念。
- **为 SidePanel 复用 `dsh-client-*` React 技术栈与连接 carrier** —— 起初否决（客户端 boot 期望服务端下推的 `__DSH_BOOT__` 插件图）；次日由静态 boot 清单 + Port 载体连接替换超越：见[SidePanel 中的 dsh Web UI](../feature/2026-08-20-dsh-web-ui-in-extension.zh.md)。
- **扩展作为本地 Node 宿主的瘦客户端**（Native Messaging / WS）—— 否决：目标是 serverless 扩展；闭包在 shim 之后可以完整落进浏览器。

## 结果

- 扩展产物（`apps/extension/dist/`）自包含：约 385 KB 的 offscreen 引擎、26 KB SW、162 KB SidePanel。
- 任何被*挂载*包新增的 `node:` 导入都会在打包期响亮地打断扩展构建——shim 清单即兼容性契约（见 `apps/extension/src/shims/` 内注释）。
- Node 专属工具族（bash/fs/shell/subagent/workflow）因组合而缺席，而非被 stub；新增任何一个都需要在相同 seam 之后提供浏览器 provider。
- DeepSeek 是唯一注册的 LLM Provider；其他 Provider 需在 `ctx.llm` 上自写扩展插件。
