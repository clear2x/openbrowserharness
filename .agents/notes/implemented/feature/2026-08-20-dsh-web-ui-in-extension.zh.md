# Agent Note: 真 dsh Web UI 运行在扩展 SidePanel 中

Status: implemented

[English](2026-08-20-dsh-web-ui-in-extension.md) | 中文

## 问题

扩展宿主最初交付的是自制迷你 SidePanel：功能可用的聊天面，但不是 DeepSeek Harness 的体验——没有侧边栏工作区管理、没有 markdown/代码渲染管线、没有各设置面板、没有那约 33 个浏览器 UI 插件。此前的架构 Note 因「客户端 boot 期望服务端下推插件图」在 v1 否决了复用 `dsh-client-*` 技术栈，这个否决留下了体验缺口。

## 决策

**未经修改的 dsh 客户端技术栈在 SidePanel 中以静态组合 boot，经 chrome.runtime Port 载体连接 offscreen 引擎。**

- boot 走 `AppWebEntry` 路径 + 自建 `__DSH_BOOT__` 清单（36 行：web-app 浏览器 roster 加 typert-registry / api-gateway / session-log-export，减去 client-hmr）。插件 bundle 是各包自己的 `lib/client.js` 产物，构建期原样复制进 `dist/plugins/<pkg>/client.js`，用默认同源 `<script>` 传输加载——全程无 eval（MV3 CSP 合规）。
- 平台 externals（react、cordis、ui-primitives…）静态 import，所有 bundle 共享同一实例；connection 插件经 `ClientModuleSystem.registerStatic` 替换为官方客户端的孪生——`WebApiClient` 换成 `PortApiClient extends AbstractApiClient`：一元调用覆写 `callUnary`（基类响应 schema 的封闭 RpcError-code 联合会毁掉宿主特有错误码），流覆写 `openMux/openHost` 为由 Port 帧喂给的生成器，帧用真实 apiproxy zod schema 二次解析。
- 引擎侧在 `dsh-api` Port 上应答（`chrome-api-bridge`）：apiproxy 方法面映射到已挂载服务、两条事件流（mux 支持 since 水位从持久化回放、host 以固定单工作区为基线）、宿主专属面返回结构化 `not-available-in-extension` 拒绝、以及通用设置命名空间 blob 存储（chrome.storage）让浏览器 UI 插件持久化自身状态（引导确认等）。
- **三个环境事实迫使加固，全部在根因处修复：**
  1. vendored loader 在模块顶层构造 `!!js` 表达式求值器（`new Function`）——import loader 就让 MV3 页面当场崩溃；求值器构造在 `vendor/loader` 中改为惰性（不用 yml 表达式的组合永不构造它）；
  2. offscreen 文档不获得 `chrome.storage` API 绑定（实测 `chrome = {loadTimes, csi, runtime}`）；全部存储访问经 `dsh-storage` 消息通道路由到 Service Worker，变更事件广播回来；
  3. 被挂载闭包的 `using` 声明（显式资源管理）把下限定在 Chrome 134——vite target 与 `minimum_chrome_version` 一同上调。

## 曾考虑的替代方案

- **`loadBundle` eval 缝**（assembled-boot 测试夹具风格）—— 否决：MV3 禁 `unsafe-eval`；静态文件 + 默认 script 传输保留官方 bundle/CSS 注入机制原封不动。
- **WebSocket/SSE 载体**（原装 `WebApiClient` 下行）—— 不可用：`chrome-extension://` 源让 WS 协议推导产出 `ws:`、相对 fetch 落到扩展源；Port 载体是唯一在所有扩展上下文都存在的传输。
- **保留迷你 SidePanel 逐步追平**—— 否决：等于永久复刻 33 个插件的界面；载体缝的存在正是为了这件事。

## 结果

- SidePanel 与 `dsh web` 界面逐像素同源（侧边栏、工作区、设置、引导、模型选择器），数据来自同一事件溯源引擎；`sidepanel.html?fixture` 可脱离引擎冒烟 boot UI。
- 无头 Chrome 冒烟（playwright + 自带 Chromium；正式版 Chrome ≥137 忽略 `--load-extension`）进入构建验证：boot 渲染、引导确认跨刷新持久化、Port RPC 往返都对着真实 bundle 断言。
- `apps/extension` 成为双面项目（`tsconfig.json` 宿主面 / `tsconfig.client.json` 浏览器 UI 面），分别注册进两个根聚合——单个 program 依旧绝不同时看到两侧 cordis Context 面。
- 旧自制 SidePanel 已删除；遗留 `ui-bridge` 仍挂载只因 offscreen boot 的会话恢复钩子（`restoreLatest`）住在那里——把它折叠进 api-bridge 已记为清理债。
