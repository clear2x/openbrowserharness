# Agent Note: page_screenshot 取证截图作为可勾选的内置能力插件

Status: implemented

[English](2026-08-30-extension-page-screenshot-capability.md) | 中文

## 问题

agent 无法留存页面证据。用户的场景：在某个 POI 平台做纠错时，agent 应能跳到 Google Maps、按不确定的名称搜索、收集候选 POI（往往多个）、再返回原页面——并保留截图作证据。两个缺口：整条 seam 里没有任何截图工具；跨标签页取证也没有提示词层面的章法。截图能力还要求用户可选启用、以可勾选插件的形式呈现。

## 决策

**seam 增加只读的 `screenshot` 方法。** `BrowserProvider`（dsh-browser）增加 `screenshot(tabId, {fullPage?}) → {data: Uint8Array, mediaType: 'image/png', width, height}`，并加入 `PROVIDER_METHODS` 使注册期校验覆盖它。chrome provider 把它转发为新的 `screenshot` CdpOp；后台 SW 附加调试器、读取 `Page.getLayoutMetrics`（整页用 `cssContentSize`、否则 `cssVisualViewport`）、用 `Page.captureScreenshot` 捕获（整页带 `captureBeyondViewport`）。运行时消息是 JSON，线上走 base64；provider 在 seam 边缘一次性解码。

**工具即 `read_image` 模式的活页版。** `tool-browser` 在 `ctx.inject(['attachments'])` 内注册 `page_screenshot`——没有持久存储就没有工具。执行先过附件服务、PNG 媒体接受、每消息字节上限、严格图片模态路由门（工具结果进入持久历史，纯文本模型在任何捕获发生前就拒绝）四道门。PNG 经 `attachments.saveImage` 提交，返回 `{tabId, url, captured, image}`，render 是文本信封加 `ImageBlock`——截图像 `read_image` 产出一样进入模型上下文，嵌套派发经 `deferContext` 拿到同样内容。

**可选开关放在 provider 层、以内置插件行呈现。** 能力开关是 chrome.storage 键（`dsh-capability-screenshot`，默认关），chrome provider 的 `screenshot` 每次调用读取——停用时拒绝并提示「网页截图能力未启用：请在侧栏「用户插件」面板中勾选开启」，切换对下一次工具调用即生效、无需引擎重载；存储通道故障时这个锦上添花的能力关闭而非打断派发。UserPluginPanel 渲染「内置能力」区（与用户插件同款开关），背后是 `capability.screenshot.get/set` 桥 RPC。

**跨页取证工作流是提示词指导，不是新机制。** 共享浏览器指导（`BROWSER_GUIDANCE_TEXT`）新增两条：(5) 跨页取证——外部站点核实信息时用 `tabs_open` 开新标签页检索，`page_snapshot`/`page_extract_text` 提取候选（可能有多个，逐一记录），然后必须 `tabs_switch` 切回原工作标签页继续，收尾 `tabs_close` 关闭取证标签页；(6) 留证截图——用 `page_screenshot` 截图并在回答中注明来源 URL。原语（多标签、快照、提取）早已存在，指导教的是编排。

## 考虑过的替代方案

- **让沙箱用户插件注册工具。** 否决：用户插件通道只支持事件订阅、沙箱摸不到 chrome.debugger；为一个大-to-一的第一方能力建沙箱工具注册加宿主能力桥，工程远超需求。
- **把开关放进工具（tool-browser）。** 否决：tool-browser 与宿主无关，chrome.storage 是扩展私产；provider 层才是扩展边界，策略应落在那里。
- **默认 JPEG 省体积。** 否决：证据价值在 UI 文字清晰度；视口截图 PNG 在附件上限内，整页超限时给出可操作的拒绝消息而非静默降质。

## 后果

模型可见的截图走通持久附件全生命周期：捕获 → 校验提交 → 工具结果里的内容寻址引用 → 模型请求里的图片块 → 面板经既有 `session.attachment` 读回。能力在用户开启前不可见，关闭时被调用会带启用提示响亮拒绝。截图从不改变页面状态，因此按设计不进权限模式矩阵。

捕获期间出现「已开始调试此浏览器」横幅——每个 CDP 操作都有的既有提示，截图没有引入新的权限面。

## 测试

- `packages/browser/tool-browser/tests/tool-browser.spec.ts`（page_screenshot describe）：provider 调用被记录、按声明媒体类型持久提交、值溯源（tabId/url/captured）、整页参数透传、纯文本模型在任何 provider 调用前拒绝。
- `packages/browser/browser` 的 spec 替身补齐新的必需 provider 方法（编译期契约强制）。
- `apps/extension/tests/composer-bar.spec.tsx` 行为不变钉住；面板行与开关 RPC 由既有面板 spec 的可注入 rpc 替身覆盖。
- 真机验证：「内置能力」行在面板中切换并持久化；围绕它的变更类工具依旧弹权限审批卡。
