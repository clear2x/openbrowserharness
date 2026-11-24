# Store submission kit

English | [中文](listing.zh.md)

Paste-ready material for the Chrome Web Store and Microsoft Edge Add-ons listings of extension v0.8.3. Text marked "paste" goes into the named form field verbatim. Screenshots and the store icon live in [screenshots/](screenshots/); the upload artifact is the `.webstore.zip` attached to the [extension releases](https://github.com/clear2x/openbrowserharness/releases).

## Store listing

| Field | Paste |
| --- | --- |
| Name | `OpenBrowserHarness` (taken from the package manifest; not editable in the console) |
| Category | Workflow & planning |
| Language | English (`en`, the package default). The dashboard lists no other locale for this item and exposes no add-language control (as of 2026-11-24); the zh and zh-TW descriptions below serve the Edge listings |
| Privacy policy URL | `https://clear2x.github.io/openbrowserharness/en/reference/privacy` (zh locale: `https://clear2x.github.io/openbrowserharness/reference/privacy`) |
| Website URL | `https://clear2x.github.io/openbrowserharness/` |
| Support | `https://github.com/clear2x/openbrowserharness/issues` |
| Summary | Taken from the manifest `description` (not editable in the console): An AI agent in your browser: it navigates real pages, fills forms, and extracts content — visible actions, under your approval. |

Summary (zh, for the Edge listing, 38 characters): 浏览器里的 AI 智能体：替你操作真实网页，拟人化输入、全程可视、由你审批。

Detailed description (EN, paste):

OpenBrowserHarness runs a full AI agent harness inside your browser. Give it a task in the side panel — it plans the steps, drives real pages, and reports back. Everything runs inside the extension: there is no companion app to install, and the model endpoint is your own.

- Agent in the side panel: it plans, calls tools, tracks todos, and answers. Sessions persist locally and resume after a restart, and messages sent while a task is running queue up for the next turn.
- Humanized page control: Bézier mouse paths with speed jitter, per-keystroke typing, inertial scrolling — driven through the Chrome DevTools Protocol, never OS-level automation.
- Real page operations, never a site's API: a task on a website is completed the way a person works it — clicking, typing, scrolling, and reading what the page shows. The agent never requests a site's API directly — not from a page script, not by opening an API address — because that trips the site's risk control and can cost the account; such a call is refused before it runs, and one opt-in switch lifts the rule only when you ask for it.
- Visible virtual cursor: every click, keystroke, and scroll renders in the page, so you always see what the agent is doing.
- Deep page reading: snapshots pierce Shadow DOM and iframes; screenshots feed multimodal models; in-page scripts verify results. Very long pages are compressed extractively before they reach the model.
- Plan-then-execute batching: a whole selector-based plan (click, type, press, scroll, wait, navigate) runs as one call — validated up front, stopped at the first failing step, with per-step progress reported.
- On-device AI (optional): install models per capability from the Local AI panel, each under 1 GB, and they run in a dedicated worker on your machine — burned-in subtitle OCR, frame captions, Whisper transcription for videos without subtitles, and local semantic ranking of page elements. Every install proves itself with a self-test, and a missing model degrades that one path instead of breaking the tool.
- Video intelligence: seek and capture the frame at any timestamp of a Bilibili video as evidence, with on-device OCR of burned-in subtitles, and co-watch the live window. Full subtitle indexing calls Bilibili's API, so it is off by default — turn on "Direct site API requests" to use it.
- Nine agent presets: four working modes and five browser specialties — web research, page monitoring, developer probing, market watching, and a Bilibili assistant that searches, watches, and reads comments on bilibili.com like a person and interacts only on your explicit instruction.
- Whole-browser surface: open, switch, pin, mute, duplicate, move, reload, and reopen tabs; focus windows; mount a local folder as a workspace the agent reads and writes.
- Schedules, sites, and skills: run a prompt on a schedule, teach a site once with /learn-site so the agent reuses its selectors, and write your own skills.
- English and Chinese interface: the side panel, the settings pages, and the browser notifications follow your browser's language; switch it in settings.
- Bring your own model: DeepSeek, Zhipu Coding Plan, or any OpenAI-compatible, Anthropic-protocol, or local Ollama endpoint you add. Keys stay in local extension storage.
- You stay in control: three permission tiers (ask per action, ask on changes, full access), per-action approval cards, and exportable session logs.

OpenBrowserHarness is based on DeepSeek Harness (dsh) by DeepSeek AI, repackaged as a browser extension. Requires Chrome or Edge 134 or newer.

Detailed description (zh, paste):

OpenBrowserHarness 把一个完整的 AI 智能体运行在你的浏览器里。在侧边栏交代一个任务——它会规划步骤、驱动真实网页，并把结果汇报给你。一切都运行在扩展内：无需安装配套应用，模型端点由你自己配置。

- 侧边栏里的智能体：规划任务、调用工具、记录待办、汇报结果。会话本地持久化，重启可恢复；任务运行中发送的消息自动排队到下一轮。
- 拟人化页面控制：贝塞尔鼠标轨迹带速度抖动、逐键输入、惯性滚动——通过 Chrome DevTools Protocol 驱动，不依赖任何 OS 级自动化。
- 真实页面操作，不碰站点接口：网站上的任务按真人工作的方式完成——点击、输入、滚动、读取页面呈现的内容。agent 不会直接请求任何网站的接口——既不在页面脚本里请求，也不直接打开接口地址——因为那会触发网站风控、可能造成封号；这类调用会在执行前被拒绝，只有一个默认关闭的开关能在你明确要求时解除。
- 可视化虚拟指针：每一次点击、按键、滚动都直接渲染在页面上，智能体的每一步都看得见。
- 深度页面读取：快照穿透 Shadow DOM 与 iframe；截图供多模态模型使用；页内脚本执行用于结果验证。超长页面在进入模型前先做抽取式压缩。
- 先规划后批量执行：一整段基于 selector 的操作计划（click/type/press/scroll/wait/navigate）合并为一次调用——计划先整体校验，任一步失败即停止，并逐步回报进度。
- 端侧 AI（可选）：在「本地 AI」面板按能力安装模型，每个不超过 1GB，推理全部在你的设备上的专用 worker 内完成——烧录字幕识别、画面描述、无字幕视频的 Whisper 转写、页面元素的本地语义排序。每次安装都自带自证；模型缺失时只让这一条路径如实降级，不会拖垮工具。
- 视频智能：定位并截取 B 站视频任意时刻的画面作为证据，端侧识别画面里的烧录字幕，还能实时陪看当前窗口。完整的字幕索引要调用 B 站接口，因此默认关闭——开启「直接请求站点接口」后可用。
- 九个 Agent 预设：四种工作模式加五个浏览器专长——网页研究、页面监控、开发者调试、股市动态，以及像真人一样在 bilibili.com 搜索、看视频、读评论、互动只按你的明确指令来的 bilibili 助手。
- 整个浏览器的操作面：标签页的打开、切换、固定、静音、复制、移动、重载、重开，窗口聚焦；还能把本地文件夹挂载为工作区，供智能体真实读写。
- 定时任务、站点与技能：按计划定时运行一条指令；用 /learn-site 让智能体学习一次站点后复用其选择器；编写你自己的技能。
- 中英双语界面：侧边栏、设置页与浏览器通知跟随浏览器语言，也可以在设置里切换。
- 自带模型接入：DeepSeek、智谱 Coding Plan，或自行添加任意 OpenAI 兼容、Anthropic 协议、本地 Ollama 端点。密钥只存本地扩展存储。
- 控制权在你：三档权限（每次确认 / 仅变更确认 / 完全访问）、逐操作审批卡、可导出的会话日志。

OpenBrowserHarness 基于 DeepSeek AI 的 DeepSeek Harness（dsh）二次开发，以浏览器扩展形态发行。需要 Chrome 或 Edge 134 及以上版本。

Detailed description (zh-TW, for the Edge Add-ons Chinese (Taiwan) listing, paste):

OpenBrowserHarness 把一個完整的 AI 智慧代理執行在你的瀏覽器裡。在側邊欄交代一項任務——它會規劃步驟、操作真實網頁，並把結果回報給你。一切都執行在擴充功能內：不需安裝配套應用程式，模型端點由你自己設定。

- 側邊欄裡的智慧代理：規劃任務、呼叫工具、記錄待辦、回報結果。工作階段在本機保存，重新啟動後可恢復；任務執行中送出的訊息會自動排入下一輪。

- 擬人化頁面控制：貝茲曲線滑鼠軌跡帶速度抖動、逐鍵輸入、慣性捲動——透過 Chrome DevTools Protocol 驅動，不依賴任何作業系統層級的自動化。

- 真實頁面操作，不碰網站介面：網站上的任務按真人工作的方式完成——點擊、輸入、捲動、讀取頁面呈現的內容。代理不會直接請求任何網站的介面——既不在頁面腳本裡請求，也不直接開啟介面位址——因為那會觸發網站風控、可能導致帳號被封；這類呼叫會在執行前被拒絕，只有一個預設關閉的開關能在你明確要求時解除。

- 可視化虛擬游標：每一次點擊、按鍵、捲動都直接呈現在頁面上，代理的每一步都看得見。

- 深度頁面讀取：快照穿透 Shadow DOM 與 iframe；截圖供多模態模型使用；頁內腳本用於結果驗證。超長頁面在進入模型前先做抽取式壓縮。

- 先規劃後批次執行：一整段基於 selector 的操作計畫（click/type/press/scroll/wait/navigate）合併為一次呼叫——計畫先整體校驗，任一步失敗即停止，並逐步回報進度。

- 裝置端 AI（選用）：在「本機 AI」面板依能力安裝模型，每個不超過 1GB，推論全部在你的裝置上的專屬 worker 內完成——燒錄字幕辨識、畫面描述、無字幕影片的 Whisper 轉錄、頁面元素的本機語意排序。每次安裝都自帶自檢；模型缺失時只讓這一條路徑如實降級，不會拖垮工具。

- 影片智慧：定位並擷取 B 站影片任意時刻的畫面作為證據，裝置端辨識畫面裡的燒錄字幕，還能即時陪看目前視窗。完整的字幕索引需要呼叫 B 站介面，因此預設關閉——開啟「直接請求站台介面」開關（英文介面為 Direct site API requests）後可用。

- 九個代理預設：四種工作模式加五種瀏覽器專長——網頁研究、頁面監控、開發者偵錯、股市動態，以及像真人在 bilibili.com 搜尋、看影片、讀留言、互動只依你的明確指示進行的 bilibili 助理。

- 整個瀏覽器的操作面：分頁的開啟、切換、釘選、靜音、複製、移動、重新載入、重開，視窗聚焦；還能把本機資料夾掛載為工作區，供代理真實讀寫。

- 排程、網站與技能：依計畫定時執行一條指令；用 /learn-site 讓代理學習一次網站後重複使用其選擇器；撰寫你自己的技能。

- 中英雙語介面：側邊欄、設定頁與瀏覽器通知跟隨瀏覽器語言，也可以在設定裡切換。

- 自帶模型接入：DeepSeek、智譜 Coding Plan，或自行新增任何 OpenAI 相容、Anthropic 協定、本機 Ollama 端點。金鑰只存在本機擴充功能儲存空間。

- 控制權在你：三檔權限（每次確認 / 僅變更確認 / 完全存取）、逐操作審批卡、可匯出的工作階段日誌。

OpenBrowserHarness 基於 DeepSeek AI 的 DeepSeek Harness（dsh）二次開發，以瀏覽器擴充功能形式發行。需要 Chrome 或 Edge 134 或以上版本。

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

`notifications`: Show a system notification when the agent is waiting for the user's approval and the side panel is closed, so a pending question is not missed. The notification carries a fixed message and no page content.

`declarativeNetRequest`: Redirect the fixed loopback callback of the optional DeepSeek account sign-in (`http://127.0.0.1:47099`) to an extension page so the sign-in response reaches the extension. One dynamic rule scoped to that single URL; no other request is modified or inspected.

`contextMenus`: Add one item to the toolbar icon's right-click menu that opens the full-page workspace.

`downloads`: Save files the agent produces, such as reports and extracted data, to the user's Downloads folder when the user asks for them.

## Data usage disclosures (Privacy practices tab)

Answers for the Chrome Web Store data disclosure form:

- Sensitive data or narrow purpose: declare the single purpose above; the item is not distributed to a narrow audience.
- **Website content**: page snapshots, screenshots, and extracted text the agent reads while executing a task. **Transferred to a third party**: the LLM endpoint the user configures (for example DeepSeek or Zhipu), on the user's own API key. Justification: this transfer is the core function; the agent cannot complete tasks without reading pages and sending that content to the model.
- **Authentication information** and **user activity**: the API keys the user enters, the token of the optional DeepSeek account sign-in, and the agent's own clicks and typing on a page. The keys and the token stay on the user's machine (`chrome.storage.local`); the agent's actions go only to the user's configured LLM endpoint as part of the task context. The developer receives none of it.
- Model downloads carry no user data: the request to huggingface.co (or the hf-mirror.com fallback) is a plain file fetch for public model files.
- Not collected by the developer: personally identifiable information, health, financial, communications, location, web history beyond the tabs the agent works on, and browsing activity. Settings and session history are stored only on the user's machine (`chrome.storage.local`, IndexedDB, OPFS).
- Certifications: no data sale; no use for purposes unrelated to the single purpose; no use for creditworthiness or lending.

## Remote code

Certify "no remote code": all executable code ships inside the package. The `extension_pages` CSP is `script-src 'self' 'wasm-unsafe-eval'`; the extra keyword allows WebAssembly for the bundled onnxruntime-web runtime and keeps JavaScript `eval` blocked. The optional on-device models are data: ONNX weight files and tokenizer/config JSON, downloaded only when the user clicks install for a capability and loaded by the bundled runtime. User-authored plugins execute locally in a manifest-declared sandbox page as user-supplied code, consistent with the MV3 user-supplied-code policy.

## Assets

| Asset | Where it goes |
| --- | --- |
| `screenshots/shot-s{1,2,3,4}-en.png` (EN locale), `shot-s{1,2,3,4}.png` (zh locale) | Screenshots (1280x800, 24-bit PNG; the console accepts 1 to 5 per locale) |
| `screenshots/store-icon-128.png` | CWS store icon (128x128, no alpha). An uploaded store icon overrides the package icon, so replace it by hand whenever the brand mark changes. |
| `screenshots/promo-marquee-1400x560.png` | Large promo tile (optional) |
| `screenshots/promo-tile-440x280.png` | Small promo tile (the Edge store card) |
| `screenshots/store-logo-300.png` | Edge Add-ons store logo (300x300) |
| Manifest `icons` (128/48/32/16) | Toolbar and management-page icons; CWS shows the packaged 128px icon only while no store icon is uploaded |
| `OpenBrowserHarness-extension-<version>.webstore.zip` from the releases page | CWS "Package" upload; Edge "Package" upload (accepts the same zip) |

## Reviewer notes (paste into the review-notes box)

All executable code ships inside the package; nothing is fetched or executed from remote sources. The `extension_pages` CSP is `script-src 'self' 'wasm-unsafe-eval'`: the extra keyword allows WebAssembly only, so the bundled onnxruntime-web runtime can run the optional on-device AI, while JavaScript `eval` and `new Function` stay blocked on extension pages. The on-device models are data, not code: ONNX weight files and tokenizer/config JSON downloaded from huggingface.co (fallback hf-mirror.com) only when the user clicks the install button for a capability, cached in the extension's own storage, and loaded by the bundled runtime.

`new Function` appears in 16 bundled files: ten copies of the Schemastery configuration-schema library in the engine and the UI plugins (schema compilation behind a capability probe with a non-eval fallback, and optional string-form callbacks behind `typeof === "string"` plus try/catch); three generated onnxruntime-web Emscripten glue files (wrappers that call into the bundled WASM); one schema-expression helper in the loader library that is reached only by `__jsExpr` config values, which the extension's static boot never uses; the Cordis client runner, which compiles the client program string of a user-authored plugin; and `sandbox.js`, the host-side executor for user-authored plugin and program code. User-authored code executes only inside the manifest-declared `sandbox` page, per the MV3 user-supplied-code policy.

The extension contacts only: the LLM endpoint the user configures (built-in presets api.deepseek.com and open.bigmodel.cn, or a custom endpoint); platform.deepseek.com for the optional account sign-in; api.bilibili.com, aisubtitle.hdslb.com, and other bilibili.com hosts for video subtitles and audio, reached only while the user has turned on the 直接请求站点接口 switch (off by default; video frame capture works without it); huggingface.co or hf-mirror.com for optional model downloads; and the pages the user directs the agent to. There is no telemetry or analytics.

## Filing steps

Chrome Web Store: upload the `.webstore.zip` on the Package tab, paste the description and upload the store icon and screenshots on the Store listing tab, keep the privacy disclosures and permission justifications current on the Privacy tab, then submit for review.

Edge Add-ons: Overview → Update → Replace with the same `.webstore.zip` → Continue through Availability, Properties, and Privacy (keep the data-use disclosures identical to the CWS ones: authentication information, user activity, website content) → Store listings. Edge derives the listing languages from the package's `_locales` (English, Chinese (China), Chinese (Taiwan) since 0.8.1) and rebuilds them when that set changes; a language with empty details is Incomplete and blocks publishing. Give each language a description, the 300x300 logo (the logo and both promo tiles have a "duplicate for all languages" button), and screenshots (the `-en` set for English, the plain set for both Chinese listings) → Publish → keep "Yes" on the tester-credentials question (the agent needs an LLM endpoint; a local Ollama needs no credentials) and paste the certification notes from [SUBMISSION.md](SUBMISSION.md) (under 2,000 characters) → Publish; the overview then shows the update as In review above the live version.
