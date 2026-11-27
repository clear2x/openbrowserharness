# 商店提交材料包

[English](../listing.md) | 中文

供 Chrome Web Store 与 Microsoft Edge Add-ons 上架扩展 v0.8.3 时直接粘贴的材料。标注「粘贴」的文本按原样填进对应表单字段；截图与商店图标在 [screenshots/](../screenshots)；上传产物是[扩展 Release](https://github.com/clear2x/openbrowserharness/releases) 页附带的 `.webstore.zip`。

## 商店列表

| 字段 | 粘贴 |
| --- | --- |
| 名称 | `OpenBrowserHarness`（取自软件包 manifest，后台不可编辑） |
| 类别 | 工作流程与规划 |
| 语言 | 英语（`en`，安装包的默认语言）。后台为该条目只列出这一种语言，也没有添加语言的入口（截至 2026-11-24）；下文的简体与台湾中文描述用于 Edge 商店 |
| 隐私政策 URL | `https://clear2x.github.io/openbrowserharness/reference/privacy`（英文 locale 用 `https://clear2x.github.io/openbrowserharness/en/reference/privacy`） |
| 网站 URL | `https://clear2x.github.io/openbrowserharness/` |
| 支持 | `https://github.com/clear2x/openbrowserharness/issues` |
| 简介 | 取自 manifest `description`（后台不可编辑）：An AI agent in your browser: it navigates real pages, fills forms, and extracts content — visible actions, under your approval. |

简介（中文，用于 Edge 商品详情，38 字）：浏览器里的 AI 智能体：替你操作真实网页，拟人化输入、全程可视、由你审批。

详细描述（英文，粘贴）：

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

详细描述（中文，粘贴）：

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

详细描述（台湾中文，用于 Edge 商店「Chinese (Taiwan)」详情，粘贴）：

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

## 单一目的

粘贴（英文）：Run an AI agent that automates browsing on the pages the user directs it to, driven by the user's own configured LLM endpoint.（在用户指定的页面上运行 AI 智能体执行浏览自动化，由用户自行配置的 LLM 端点驱动。）

## 逐权限论证

`debugger`：通过 Chrome DevTools Protocol 驱动用户任务所指的标签页——鼠标、键盘、滚动与页面读取。扩展只 attach 任务正在操作的标签页，会话结束即 detach。

`tabs` 与 `activeTab`：作为智能体任务的一部分列出、切换和管理标签页；用户点击工具栏图标时授予对当前标签页的临时访问。标签页 URL 与标题只在智能体正在处理的标签页上读取。

`host_permissions`（`<all_urls>`）：用户可以把智能体指向其正在浏览的任意页面；智能体读取的页面内容只发送到用户自行配置的 LLM 端点。没有任务时，扩展不会在后台作用于任何页面。

`storage`：通过 `chrome.storage.local` 在本地保存用户的 API Key、供应商设置、插件与偏好。除作为用户所选端点的认证头外，任何内容都不传输。

`offscreen`：在 Offscreen 文档中承载长驻智能体引擎，浏览器打开期间智能体持续运行。

`sidePanel`：在浏览器侧边栏中渲染智能体对话界面。

`alarms`：运行内部保活定时器，在浏览器回收引擎时重建它，保证当前会话存活。

`sessions`：让智能体在任务需要时重新打开用户最近关闭的标签页。

`notifications`：当智能体正在等待用户审批而侧边栏处于关闭状态时，发出一条系统通知，避免遗漏待答复的问题。通知只携带固定文案，不含任何页面内容。

`declarativeNetRequest`：把可选的 DeepSeek 账号登录的固定回环回调（`http://127.0.0.1:47099`）重定向到扩展页面，使登录响应能到达扩展。仅此一条动态规则且只匹配这一个 URL，不修改也不查看其他任何请求。

`contextMenus`：在工具栏图标的右键菜单中添加一项，用于打开全页工作台。

`downloads`：在用户要求时，把智能体产出的文件（如报告、提取的数据）保存到用户的下载文件夹。

## 数据使用披露（隐私做法页签）

Chrome Web Store 数据披露表单的答案：

- 敏感数据或窄用途：声明上面的单一目的；本扩展不面向窄受众分发。
- **网站内容**：智能体执行任务时读取的页面快照、截图与提取文本。**会传输给第三方**：用户自行配置的 LLM 端点（如 DeepSeek 或智谱），使用用户自己的 API Key。理由：该传输是核心功能——智能体必须读取页面并把内容发给模型才能完成任务。
- **身份验证信息**与**用户活动**：用户输入的 API Key、可选的 DeepSeek 账号登录令牌，以及智能体自己在页面上的点击与输入。Key 与令牌只保存在用户机器上（`chrome.storage.local`）；智能体的操作只作为任务上下文发送到用户自行配置的 LLM 端点。开发者不接收其中任何一项。
- 模型下载不携带用户数据：发往 huggingface.co（或回退的 hf-mirror.com）的请求只是对公开模型文件的普通文件获取。
- 开发者不收集：个人身份信息、健康、金融、通讯、位置、网页历史（智能体正在处理的标签页除外）与浏览活动。设置与会话历史只保存在用户机器上（`chrome.storage.local`、IndexedDB、OPFS）。
- 三项证明：不出售数据；不将其用于与单一目的无关的用途；不用于信用资质或放贷决策。

## 远程代码

声明「不含远程代码」：所有可执行代码随安装包内置。`extension_pages` CSP 为 `script-src 'self' 'wasm-unsafe-eval'`；多出的关键字只为包内的 onnxruntime-web 运行时放行 WebAssembly，JavaScript `eval` 仍然被拦。可选的端侧模型是数据而非代码：ONNX 权重文件与分词器/配置 JSON，只在用户为某项能力点击安装时下载，并由包内运行时加载。用户自编插件作为用户提供代码，在 manifest `sandbox` 声明的沙箱页面内本地执行，符合 MV3 用户代码政策。

## 素材对照

| 素材 | 用途 |
| --- | --- |
| `screenshots/shot-s{1,2,3,4}-en.png`（英文 locale）、`shot-s{1,2,3,4}.png`（中文 locale） | 屏幕截图（1280x800、24 位 PNG；后台每个 locale 接受 1 到 5 张） |
| `screenshots/store-icon-128.png` | CWS 商店图标（128x128、无 alpha）。手工上传的商店图标会覆盖包内图标，品牌标识变更时必须手工替换。 |
| `screenshots/promo-marquee-1400x560.png` | 大型宣传图块（可选） |
| `screenshots/promo-tile-440x280.png` | 小型宣传图块（Edge 商店卡片） |
| `screenshots/store-logo-300.png` | Edge Add-ons 商店 logo（300x300） |
| manifest `icons`（128/48/32/16） | 工具栏与扩展管理页图标；仅在未上传商店图标时，CWS 才显示包内 128px 图标 |
| Release 页的 `OpenBrowserHarness-extension-<版本>.webstore.zip` | CWS「文件包」上传；Edge「程序包」上传（同一个 zip） |

## 审核员说明（粘贴进 review-notes 栏）

所有可执行代码随安装包内置，不从远程获取或执行任何代码。`extension_pages` CSP 为 `script-src 'self' 'wasm-unsafe-eval'`：多出的关键字只放行 WebAssembly，使包内的 onnxruntime-web 运行时能够运行可选的端侧 AI，而 JavaScript `eval` 与 `new Function` 在扩展页面上仍被拦截。端侧模型是数据而非代码：ONNX 权重文件与分词器/配置 JSON，只在用户为某项能力点击安装按钮时从 huggingface.co（回退 hf-mirror.com）下载，缓存在扩展自己的存储中，由包内运行时加载。

`new Function` 出现在 16 个打包文件中：引擎与各 UI 插件里的十份 Schemastery 配置 schema 库副本（schema 编译位于能力探测之后并带有非 eval 回退，可选的字符串回调位于 `typeof === "string"` 加 try/catch 双重守卫之后）；三个生成的 onnxruntime-web Emscripten 胶水文件（调用包内 WASM 的包装函数）；loader 库中的一个 schema 表达式助手，只有 `__jsExpr` 配置值才会到达，而扩展的静态引导从不使用；Cordis client runner，用于编译用户自编插件的客户端程序字符串；以及 `sandbox.js`，用户自编插件与程序代码的宿主侧执行器。用户自编代码只在 manifest 声明的 `sandbox` 页面内执行，符合 MV3 用户代码政策。

扩展只连接以下端点：用户自行配置的 LLM 端点（内置预设 api.deepseek.com 与 open.bigmodel.cn，或自定义端点）；可选账号登录使用的 platform.deepseek.com；仅在用户开启「直接请求站点接口」开关（默认关闭；不带它也能截取视频画面）时，用于字幕与音频的 api.bilibili.com、aisubtitle.hdslb.com 及其他 bilibili.com 主机；可选模型下载使用的 huggingface.co 或 hf-mirror.com；以及用户把智能体指向的页面。无任何遥测或分析。

## 提交步骤

Chrome Web Store：在「文件包」页签上传 `.webstore.zip`，在「商品详情」页签粘贴简介并上传商店图标与截图，在「隐私权」页签保持数据披露与逐权限论证为最新，然后提交审核。

Edge Add-ons：概览 → Update → Replace 上传同一个 `.webstore.zip` → 依次通过 Availability、Properties、Privacy（数据使用披露与 CWS 保持一致：身份验证信息、用户活动、网站内容）→ Store listings。Edge 按安装包的 `_locales` 推导详情语言（自 0.8.1 起为 English、Chinese (China)、Chinese (Taiwan)），语言集合变化时会重建；详情为空的语言显示 Incomplete 并阻止发布。为每种语言填写描述、300x300 logo（logo 与两张宣传图块都有「复制到所有语言」按钮）和截图（英文用 `-en` 那套，两种中文用无后缀那套）→ Publish → 测试人员凭据问题保持「Yes」（智能体需要一个 LLM 端点；本地 Ollama 不需要任何凭据），粘贴 [SUBMISSION.zh.md](SUBMISSION.md) 里的认证说明（2000 字符以内）→ Publish；之后概览页在线上版本上方显示该更新为 In review。
