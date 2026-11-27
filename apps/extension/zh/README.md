# OpenBrowserHarness（openbrowserharness-extension）

[English](../README.md) | 中文

DeepSeek Harness 的 Chrome MV3 扩展宿主：完整的 dsh agent loop（Cordis 微内核、事件溯源会话、工具运行时、LLM 适配器）**完全在浏览器内运行**，长驻于 Offscreen 文档——无需任何 Node 进程。

## 这是什么

- **插件形态的 dsh** —— 与 Node 宿主相同的插件包，以浏览器方式引导（`new Context()` + Loader 静态模块映射，不读 yml 文件）。
- **长时间运行** —— 引擎驻留 Offscreen 文档；会话事件溯源持久化到 IndexedDB（`dsh-session-persistence-indexeddb`，含崩溃修复），预配置的 `main` agent 携带稳定会话身份，Offscreen 被重建后自动恢复同一会话。Service Worker 的 alarms 看门狗在 Chrome 回收 Offscreen 后重建引擎宿主。
- **浏览器能力即 dsh 工具** —— `dsh-tool-browser` 在 `ctx.browser` seam 上暴露 `tabs_*` / `page_*` 工具；扩展 provider 用 `chrome.debugger`（CDP）驱动拟人化输入：三阶贝塞尔鼠标轨迹、随机化击键节奏、穿透 Shadow DOM/iframe 的页面快照。
- **可见的虚拟指针** —— CDP 输入不移动系统指针，因此每个手势同时在页面内渲染 overlay：跟随真实派发坐标的指针箭头、渐隐轨迹与点击涟漪（见[虚拟指针 Agent Note](../../../.agents/notes/implemented/feature/zh/2026-08-20-visible-virtual-cursor.md)）。
- **网站任务靠真实页面操作** —— 在网站上完成任何事——搜索、打开、翻页、展开、点赞、关注、评论、提交——都像真人一样操作页面（打开、点击、输入、滚动、读页面呈现的内容），不调用站点接口。网站的接口一律不直接请求——这会触发网站风控、有封号风险。提示词准则之外有一道硬闸：`page_evaluate` 表达式或 PTC `run_code` 程序里出现 fetch/XHR 等请求、`tabs_open` / `page_navigate` / `page_batch_actions` 的 navigate 步骤或 `web_fetch` 指向接口地址、`video_index` 建索引，工具闸都在执行前直接拒绝并指回页面工具，完全访问模式下同样生效。内置能力「直接请求站点接口」默认关闭，只有你明确要求并接受这一风险时才开启（见[页面操作决策](../../../.agents/notes/implemented/feature/zh/2026-11-24-website-tasks-through-page-operations.md)与[封号风险决策](../../../.agents/notes/implemented/feature/zh/2026-11-24-no-direct-site-api-requests.md)）。
- **开箱即用的场景预设** —— 预设切换器出厂自带九个 system 信任预设：四个原生模式（标准、PTC、极简、创造）与五个浏览器专长（网页研究、页面监控、开发者调试、股市动态、bilibili 助手）。每个都跟随你的模型路由，把工作纪律编码为提示词附加段（多源交叉验证、不可逆动作先确认、只读边界）。bilibili 助手按上面的铁律操作 B 站：搜索、看视频、读评论与动态、管理收藏关注，互动只在你的明确指令下进行。新会话默认完全访问权限；盾牌 chip 可随时切回按变更或按次确认。
- **操作又准又诚实** —— 点击前做命中校验（被遮挡/视口外的目标直接报错并给原因，不再静默空点），输入后从页面回读校验；反思守护在收尾单薄或工具连续失败时提醒 agent 换路、对照目标补齐。18 个内置能力开关（选装的网页截图、快照精简/脱敏、链接净化、导航等待、禁媒体、提交拦截、页面脚本请求接口、工具按需加载……）在用户插件面板随时调配。
- **站点学习（`/learn-site`）** —— 一条斜杠指令机械式爬取当前标签页的站点（同源子页面，专用学习标签页内完成），把路径、表单与稳定选择器凝练成按主机分组的速查表，存为用户插件（`site-<主机名>`）。当该主机是活动标签页时，速查表注入为模型上下文，agent 直接按已知选择器操作站点，不再为重新发现结构反复快照（见[站点学习 Agent Note](../../../.agents/notes/implemented/feature/zh/2026-10-08-site-learn-command.md)）。
- **视频智能（`video_index` / `sense_now`）** —— 字幕优先的长视频索引：`index` 经白名单 API 通道拉取 B 站官方/AI 字幕零下载建索引（挂载伴生 MCP 服务后解锁 FFmpeg/ASR 级满血引擎），`query` 以 `[mm:ss–mm:ss] 台词 (EVID_x)` 引用行作答，`zoom` 驱动真实播放器 seek 并截取任意时间点的画面帧（持久记入索引的帧证据库），也可以直接传视频页 URL——不需要索引，也不请求接口。`index` 要直接请求 B 站接口（带登录态），默认被禁止：开启「直接请求站点接口」后才可用。`sense_now` 实时陪看当前窗口：有界采样轮次、三档差分留帧，每轮把拼图作为画面证据提交。
- **端侧 AI（全部模型 ≤1GB，CPU 优先）** —— 「本地 AI」面板按能力安装模型，推理全部运行在专用 AI worker 内：PP-OCRv4 从截取帧读取烧录字幕（无 GPU 可用），SmolVLM2-256M 生成画面描述（WebGPU），Whisper-base 把无字幕视频的音频转写进索引（`index` 自动回退，≤8 分钟视频），multilingual-e5-small 驱动 `page_find_related`——按任务对页面元素做语义排序，大页面免翻截断快照；每个命中元素都带唯一标记 selector，无论页面有没有给它 id/aria 属性，`page_click` / `page_type` / `page_batch_actions` 都能直接寻址。抓取/渲染压缩（抽取式、确定性）在超长页面文本进入模型前先行裁剪。每项能力安装即自证；模型缺失时该通道诚实降级，不拖垮工具。
- **按本机速度节拍的本地转写** —— Whisper 转写按约 60 秒一段进行（切点落在最安静的瞬间，不切断词），每段完成后用实测速度推算剩余音频能否在时限内完成；本机太慢时就停在已转写处并**保留已有成果**，而不是烧完时限后一无所获。索引记录转写覆盖到第几分钟，`index` / `status` / `query` 的输出都明说其后未转写，模型不会把「没转写到」当成「视频里没讲」。「本地 AI」使用账本逐次记下取流 / 解码 / 转写三段耗时。
- **批量页面操作** —— `page_batch_actions` 把一整段页面操作计划（click / click_at / type / press / scroll / wait / navigate）合并为一次调用，替代多轮 page_* 往返：计划先整体校验再运行，任一步失败即停止并回报逐步进度；每个点击/输入目标先自动等待出现并滚动到视口内，每个可变步骤都等它引发的跳转完成后再跑下一步。
- **工具按需加载** —— 不常用的工具套件（团队协作与子代理、定时任务、文件工作区、后台任务）默认不出现在模型的工具列表里：一个很小的 `load_tools` 工具带着目录，模型加载某组后该组在本会话持续可用；模型若直接调用尚未加载的工具，系统当场加载它所在的组并提示重新调用。默认请求体约减半（69 → 46 个工具）；「工具按需加载」能力开关可恢复全量工具，PTC 模式下始终全量。
- **自愈的调试器通道** —— 附加后立即断开的调试会话按退避节奏重试，命令发现会话已断则重新附加并只再执行一次，被休眠卸载的标签页先重载再附加，持续失败时报错直指原因：浏览器层的现场状态与最近一次断开事件（包括浏览器「已开始调试此浏览器——取消」提示条被取消）。
- **整体替换式输入** —— 向已有内容的输入框 `page_type` 时先清空再敲字，实时联想与校验不会再看到「旧值+新字」的中间态（此前要靠回读事后覆写）。
- **本地化外壳（中/英）** —— 本 fork 自有面板的全部文案（输入条、对话外壳、用户插件 / 服务 / 自动化面板、预设页、内置预设名、端侧模型标签）都在 `src/sidepanel-dsh/locales/` 的带类型字典里，经上游 locale 服务出文案：英文浏览器得到英文面板，运行中切换语言即时重绘。`verify-client-ui-i18n` 覆盖 `sidepanel-dsh`，文案无法再写回组件。供应商显示名属于引擎的视图数据：面板上报自己的活跃 locale（`ui/language`），引擎按该语言给内置供应商出名称。面板之外：工具栏标题、简介、右键菜单与等待通知经 `public/_locales/` 跟随浏览器界面语言，OAuth 中转页自行读取浏览器语言。

决策记录（shim 策略与被否决的替代方案）见[架构 Agent Note](../../../.agents/notes/implemented/architecture/zh/2026-08-19-browser-extension-host.md)。

## 目录

| 路径 | 职责 |
| --- | --- |
| `src/background/` | Service Worker：CDP 控制器（贝塞尔鼠标、键盘仿真、穿透快照）、标签页操作、消息路由、Offscreen 看门狗 |
| `src/offscreen/` | 引擎宿主：浏览器式 boot + 插件组合 + 自动恢复 |
| `src/chrome/` | 扩展原生 dsh 插件：`chrome-credentials`、`chrome-llm`（基于 chrome.storage 的 DeepSeek 适配）、`chrome-browser-provider`、`ui-bridge` |
| `src/sidepanel-dsh/` | 真 dsh Web UI boot（静态清单、平台种子、PortApiClient 载体） |
| `src/sidepanel-dsh/locales/` | 外壳的中/英字典与 locale 字座（`installShellLocale`）；组件经 `useShellT()` / `shellT()` 取文案 |
| `public/_locales/` | manifest 消息（`__MSG__`）与 Service Worker 经 `chrome.i18n` 读取的文案 |
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
