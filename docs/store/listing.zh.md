# 商店提交材料包

[English](listing.md) | 中文

供 Chrome Web Store 与 Microsoft Edge Add-ons 上架时直接粘贴的材料。标注「粘贴」的文本按原样填进对应表单字段；截图与商店 logo 在 [screenshots/](screenshots/)；上传产物是[扩展 Release](https://github.com/clear2x/openbrowserharness/releases) 页附带的 `.webstore.zip`。

## 商店列表

| 字段 | 粘贴 |
| --- | --- |
| 名称（中文 locale） | OpenBrowserHarness — 浏览器 AI 智能体 |
| 名称（英文 locale） | OpenBrowserHarness — Browser AI Agent |
| 类别 | 效率 / Productivity |
| 语言 | 简体中文（可加 English 作为第二 locale） |
| 隐私政策 URL | `https://clear2x.github.io/openbrowserharness/reference/privacy`（英文 locale 用 `https://clear2x.github.io/openbrowserharness/en/reference/privacy`） |
| 网站 URL | `https://clear2x.github.io/openbrowserharness/` |
| 支持 | `https://github.com/clear2x/openbrowserharness/issues` |

简介（中文，42 字）：浏览器里的 AI 智能体：替你操作真实网页，拟人化输入、全程可视、由你审批。

简介（英文，127 字符）：An AI agent in your browser: it plans, clicks, types, and reads real pages for you — visibly, under your approval.

详细描述（中文，粘贴）：

OpenBrowserHarness 把一个完整的 AI 智能体运行在你的浏览器里。在侧边栏交代一个任务——它会规划步骤、驱动真实网页，并把结果汇报给你。

- 侧边栏里的智能体：规划任务、调用工具、记录待办、汇报结果；会话本地持久化，重启可恢复。
- 拟人化页面控制：贝塞尔鼠标轨迹带速度抖动、逐键输入、惯性滚动——通过 Chrome DevTools Protocol 驱动，不依赖任何 OS 级自动化。
- 可视化虚拟指针：每一次点击、按键、滚动都直接渲染在页面上，智能体的每一步都看得见。
- 深度页面读取：快照穿透 Shadow DOM 与 iframe；截图供多模态模型使用；页内脚本执行用于结果验证。
- 整个浏览器的操作面：标签页的打开、切换、固定、静音、复制、移动、重载、重开，以及窗口聚焦。
- 自带模型接入：DeepSeek、智谱 GLM，或任意 OpenAI 兼容、Anthropic 协议、本地 Ollama 端点。密钥只存本地扩展存储。
- 控制权在你：三档权限（每次确认 / 仅变更确认 / 完全访问）、逐操作审批卡、可导出的会话日志。

OpenBrowserHarness 基于 DeepSeek AI 的 DeepSeek Harness（dsh）二次开发，以浏览器扩展形态发行。需要 Chrome 或 Edge 134 及以上版本。

详细描述（英文，粘贴）：

OpenBrowserHarness runs a full AI agent harness inside your browser. Give it a task in the side panel — it plans the steps, drives real pages, and reports back.

- Agent in the side panel: it plans, calls tools, tracks todos, and answers. Sessions persist locally and resume after a restart.
- Humanized page control: Bézier mouse paths with speed jitter, per-keystroke typing, inertial scrolling — driven through the Chrome DevTools Protocol, never OS-level automation.
- Visible virtual cursor: every click, keystroke, and scroll renders in the page, so you always see what the agent is doing.
- Deep page reading: snapshots pierce Shadow DOM and iframes; screenshots feed multimodal models; in-page scripts verify results.
- Whole-browser surface: open, switch, pin, mute, duplicate, move, reload, and reopen tabs; focus windows.
- Bring your own model: DeepSeek, Zhipu GLM, or any OpenAI-compatible, Anthropic-protocol, or local Ollama endpoint. Keys stay in local extension storage.
- You stay in control: three permission tiers (ask per action, ask on changes, full access), per-action approval cards, and exportable session logs.

OpenBrowserHarness is based on DeepSeek Harness (dsh) by DeepSeek AI, repackaged as a browser extension. Requires Chrome or Edge 134 or newer.

## 单一目的

粘贴：在用户指定的页面上运行 AI 智能体执行浏览自动化，由用户自行配置的 LLM 端点驱动。

## 逐权限论证

`debugger`：通过 Chrome DevTools Protocol 驱动用户任务所指的标签页——鼠标、键盘、滚动与页面读取。扩展只 attach 任务正在操作的标签页，会话结束即 detach。

`tabs` 与 `activeTab`：作为智能体任务的一部分列出、切换和管理标签页；用户点击工具栏图标时授予对当前标签页的临时访问。标签页 URL 与标题只在智能体正在处理的标签页上读取。

`host_permissions`（`<all_urls>`）：用户可以把智能体指向其正在浏览的任意页面；智能体读取的页面内容只发送到用户自行配置的 LLM 端点。没有任务时，扩展不会在后台作用于任何页面。

`storage`：通过 `chrome.storage.local` 在本地保存用户的 API Key、供应商设置、插件与偏好。除作为用户所选端点的认证头外，任何内容都不传输。

`offscreen`：在 Offscreen 文档中承载长驻智能体引擎，浏览器打开期间智能体持续运行。

`sidePanel`：在浏览器侧边栏中渲染智能体对话界面。

`alarms`：运行内部保活定时器，在浏览器回收引擎时重建它，保证当前会话存活。

`sessions`：让智能体在任务需要时重新打开用户最近关闭的标签页。

## 数据使用披露（隐私做法页签）

Chrome Web Store 数据披露表单的答案：

- 是否处理敏感数据或声明窄用途？声明上面的单一目的；本扩展不面向窄受众分发。
- 收集的数据：**网站内容**——智能体执行任务时读取的页面快照、截图与提取文本。它**会传输给第三方**：用户自行配置的 LLM 端点（如 DeepSeek 或智谱），使用用户自己的 API Key。理由：该传输是核心功能——智能体必须读取页面并把内容发给模型才能完成任务。
- 不收集的数据：开发者不收集个人身份信息、健康、金融、认证凭据、通讯、位置、网页历史（智能体正在处理的标签页除外）与用户活动。API Key、设置与会话历史只保存在用户机器上（`chrome.storage.local`、IndexedDB）。
- 三项证明：不出售数据；不将其用于与单一目的无关的用途；不用于信用资质或放贷决策。

## 远程代码

声明「不含远程代码」：所有可执行代码随安装包内置。用户自编插件（可选、默认关闭）作为用户提供代码，在 manifest `sandbox` 声明的沙箱页面内本地执行，符合 MV3 用户代码政策。

## 素材对照

| 素材 | 用途 |
| --- | --- |
| `screenshots/shot-s{1,2,3}-en.png`（英文 locale）、`shot-s{1,2,3}.png`（中文 locale） | 截图页签（1280x800；CWS 最多 8 张，Edge 至少 1 张） |
| `screenshots/store-logo-300.png` | Edge Add-ons 商店 logo（300x300） |
| manifest `icons`（128/48/32/16） | CWS 自动使用包内 128px 图标 |
| Release 页的 `OpenBrowserHarness-extension-<版本>.webstore.zip` | CWS「程序包」上传；Edge「程序包」上传（同一个 zip） |

## 提交步骤

Chrome Web Store：缴一次性 $5 开发者费 → 填上面的数据披露答案 → 粘贴逐权限论证 → 上传 `.webstore.zip` → 添加截图 → 挂隐私政策链接 → 提交审核。

Edge Add-ons：免费注册 → 上传同一个 `.webstore.zip` → 填等价字段 → 添加至少 1 张截图与 300x300 logo → 提交。
