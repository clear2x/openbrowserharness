# Store submission kit

English | [中文](listing.zh.md)

Paste-ready material for the Chrome Web Store and Microsoft Edge Add-ons listings. Text marked "paste" goes into the named form field verbatim. Screenshots and the store logo live in [screenshots/](screenshots/); the upload artifact is the `.webstore.zip` attached to the [extension releases](https://github.com/clear2x/openbrowserharness/releases).

## Store listing

| Field | Paste |
| --- | --- |
| Name (EN locale) | OpenBrowserHarness — Browser AI Agent |
| Name (zh locale) | OpenBrowserHarness — 浏览器 AI 智能体 |
| Category | Productivity |
| Language | English (add 简体中文 as a second locale) |
| Privacy policy URL | `https://clear2x.github.io/openbrowserharness/en/reference/privacy` (zh locale: `https://clear2x.github.io/openbrowserharness/reference/privacy`) |
| Website URL | `https://clear2x.github.io/openbrowserharness/` |
| Support | `https://github.com/clear2x/openbrowserharness/issues` |

Summary (EN, 114 characters): An AI agent in your browser: it plans, clicks, types, and reads real pages for you — visibly, under your approval.

Summary (zh, 38 characters): 浏览器里的 AI 智能体：替你操作真实网页，拟人化输入、全程可视、由你审批。

Detailed description (EN, paste):

OpenBrowserHarness runs a full AI agent harness inside your browser. Give it a task in the side panel — it plans the steps, drives real pages, and reports back.

- Agent in the side panel: it plans, calls tools, tracks todos, and answers. Sessions persist locally and resume after a restart.
- Humanized page control: Bézier mouse paths with speed jitter, per-keystroke typing, inertial scrolling — driven through the Chrome DevTools Protocol, never OS-level automation.
- Visible virtual cursor: every click, keystroke, and scroll renders in the page, so you always see what the agent is doing.
- Deep page reading: snapshots pierce Shadow DOM and iframes; screenshots feed multimodal models; in-page scripts verify results.
- Whole-browser surface: open, switch, pin, mute, duplicate, move, reload, and reopen tabs; focus windows.
- Bring your own model: DeepSeek, Zhipu GLM, or any OpenAI-compatible, Anthropic-protocol, or local Ollama endpoint. Keys stay in local extension storage.
- You stay in control: three permission tiers (ask per action, ask on changes, full access), per-action approval cards, and exportable session logs.

OpenBrowserHarness is based on DeepSeek Harness (dsh) by DeepSeek AI, repackaged as a browser extension. Requires Chrome or Edge 134 or newer.

Detailed description (zh, paste):

OpenBrowserHarness 把一个完整的 AI 智能体运行在你的浏览器里。在侧边栏交代一个任务——它会规划步骤、驱动真实网页，并把结果汇报给你。

- 侧边栏里的智能体：规划任务、调用工具、记录待办、汇报结果；会话本地持久化，重启可恢复。
- 拟人化页面控制：贝塞尔鼠标轨迹带速度抖动、逐键输入、惯性滚动——通过 Chrome DevTools Protocol 驱动，不依赖任何 OS 级自动化。
- 可视化虚拟指针：每一次点击、按键、滚动都直接渲染在页面上，智能体的每一步都看得见。
- 深度页面读取：快照穿透 Shadow DOM 与 iframe；截图供多模态模型使用；页内脚本执行用于结果验证。
- 整个浏览器的操作面：标签页的打开、切换、固定、静音、复制、移动、重载、重开，以及窗口聚焦。
- 自带模型接入：DeepSeek、智谱 GLM，或任意 OpenAI 兼容、Anthropic 协议、本地 Ollama 端点。密钥只存本地扩展存储。
- 控制权在你：三档权限（每次确认 / 仅变更确认 / 完全访问）、逐操作审批卡、可导出的会话日志。

OpenBrowserHarness 基于 DeepSeek AI 的 DeepSeek Harness（dsh）二次开发，以浏览器扩展形态发行。需要 Chrome 或 Edge 134 及以上版本。

## Single purpose

Paste (EN): Run an AI agent that automates browsing on the pages the user directs it to, driven by the user's own configured LLM endpoint.

## Permission justifications

`debugger`: Drive the tab the user's task targets — mouse, keyboard, scrolling, and page reading — through the Chrome DevTools Protocol. The extension attaches only to the tab a task is operating on and detaches when the session ends.

`tabs` and `activeTab`: List, switch, and manage tabs as part of agent tasks, and grant temporary access to the current tab when the user clicks the toolbar icon. Tab URLs and titles are read only for tabs the agent is working with.

`host_permissions` (`<all_urls>`): The user can direct the agent at any page they are browsing; the page content the agent reads is sent only to the LLM endpoint the user configures. The extension does not run in the background on pages without a task.

`storage`: Store the user's API keys, provider settings, plugins, and preferences locally via `chrome.storage.local`. Nothing is transmitted except as authentication headers to the user's chosen endpoint.

`offscreen`: Host the long-lived agent engine in an Offscreen document so the agent keeps running while the browser is open.

`sidePanel`: Render the agent conversation UI in the browser's side panel.

`alarms`: Run an internal keep-alive timer that recreates the Offscreen engine if the browser reclaims it, so the current conversation survives.

`sessions`: Let the agent reopen tabs the user recently closed when a task calls for it.

## Data usage disclosures (Privacy practices tab)

Answers for the Chrome Web Store data disclosure form:

- Does the item handle sensitive data or declare a narrow purpose? Declare the single purpose above; the item is not distributed to a narrow audience.
- Data collected: **Website content** — page snapshots, screenshots, and extracted text the agent reads while executing a task. It is **transferred to a third party**: the LLM endpoint the user configures (for example DeepSeek or Zhipu), acting on the user's own API key. Justification: this transfer is the core function; the agent cannot complete tasks without reading pages and sending that content to the model.
- Data not collected: personally identifiable information, health, financial, authentication, communications, location, web history (beyond the tab the agent works on), and user activity are not collected by the developer. API keys, settings, and session history are stored only on the user's machine (`chrome.storage.local`, IndexedDB).
- Certifications: no data sale; no use for purposes unrelated to the single purpose; no use for creditworthiness or lending.

## Remote code

Certify "no remote code": all executable code ships inside the package. User-authored plugins (optional, off by default) execute locally in a manifest-declared sandbox page as user-supplied code, consistent with the MV3 user-supplied-code policy.

## Assets

| Asset | Where it goes |
| --- | --- |
| `screenshots/shot-s{1,2,3}-en.png` (EN locale), `shot-s{1,2,3}.png` (zh locale) | Screenshots tab (1280x800; CWS takes up to 8, Edge requires at least 1) |
| `screenshots/promo-marquee-1400x560.png` | Optional CWS marquee promo (for featuring consideration) |
| `screenshots/promo-tile-440x280.png` | Optional CWS small promo tile |
| `screenshots/store-logo-300.png` | Edge Add-ons store logo (300x300) |
| Manifest `icons` (128/48/32/16) | CWS uses the packaged 128px icon automatically |
| `OpenBrowserHarness-extension-<version>.webstore.zip` from the releases page | CWS "Package" upload; Edge "Package" upload (accepts the same zip) |

## Reviewer notes (paste into the review-notes box)

All executable code ships inside the package; nothing is fetched or executed from remote sources. `new Function` appears in three bundled files, all in the Schemastery configuration library: one is an `allowsEval` capability probe wrapped in try/catch (it cleanly detects the extension-page CSP and falls back to the library's jitless mode), and two compile optional string-form schema callbacks behind `typeof === "string"` plus try/catch (the extension's bundled configurations pass real functions, so the path is unreachable). User-authored plugins execute only inside the manifest-declared `sandbox` page, per the MV3 user-supplied-code policy. The only network endpoints are the LLM providers the user configures (api.deepseek.com, open.bigmodel.cn by default, or a custom endpoint); there is no telemetry.

## Filing steps

Chrome Web Store: pay the one-time $5 developer fee, fill the data-disclosure answers above, paste the permission justifications, upload the `.webstore.zip`, add the screenshots, link the privacy policy, then submit for review.

Edge Add-ons: register free, upload the same `.webstore.zip`, fill the equivalent fields, add at least one screenshot plus the 300x300 logo, then submit.
