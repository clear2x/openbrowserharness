# Changelog

All notable changes to OpenBrowserHarness are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [Semantic Versioning](https://semver.org/). Pre-1.0, anything may
change without notice.

## [0.8.0] - 2026-11-23

### Added

- **端侧 AI（「本地 AI」面板，全部模型 ≤1GB、CPU 优先）**：按能力安装、推理全部运行在专用 AI worker 内——PP-OCRv4 从截取帧读取烧录字幕（无 GPU 可用），SmolVLM2-256M 生成画面描述（WebGPU），Whisper-base 把无字幕视频的音频转写进索引（`video_index index` 自动回退，≤8 分钟视频，B 站音频经页面通道直取、CDN 放行空 referer），multilingual-e5-small 驱动 `page_find_related`——按任务对页面元素做本地语义排序，大页面免翻截断快照。模型目录硬闸 1GB、hf-mirror 镜像回退、安装即自证；「最近使用」账本把每次本地推理真实记入轨迹（时间/能力/模型/耗时/摘要）。
- **抓取/渲染抽取式压缩**：超长页面文本在进入模型前按信息量裁剪（词频+CJK bigram 打分、标题必留、冗余闸 0.6、尾部保底）——同 4000 字符预算下保住标题与高密度句，模型少一次「再取后半段」的往返。`page_extract_text` 超长文本默认启用。
- **批量页面操作（`page_batch_actions`）**：把一整段基于 selector 的操作计划（click/type/press/scroll/wait/navigate，≤12 步）合并为一次调用，替代多轮 page_* 往返——计划先整体校验再运行、任一步失败即停止并回报逐步进度、可变步骤之间做页面就绪 settle（点击引发的跳转不会跟下一步抢跑）；selector 可先由 `page_find_related` 获取，两条速度层天然衔接。
- **真机自走回归（zhipu-e2e）**：真 Edge + 真扩展 + 真模型（智谱 Coding Plan）驱动的闭环探针——快照健康闸（零调试器错误）、批量登录链（真实 DOM 落页断言）、MCP 桥控制面（tools/list + session_list + dsh_rpc）三场景；mock 探针族扩至 21 项。

### Fixed

- **page_snapshot 在产物构建上全断（「G is not defined」）**：注入模板用源码原名绑定内联函数，而 minify 改名模块作用域——函数体内互调用的是改名后的名字，页面上不存在。五个注入模板（快照走查/元素重解析/点击命中探针/等待轮询/陪看采样检查源）的绑定与调用点全部改为经 `fn.name`（开发态=原名、产物态=minify 名，两边自洽）；新增产物级回归锁：esbuild 按产物同款 minify 拼装表达式，TypeScript AST 静态扫自由标识符，任何未来泄漏在这里失败而不是用户页面。由 zhipu-e2e 真模型探针首轮真机抓到。
- **调试器通道自愈 + 现场事实错误**：attach 成功但 Page.enable 即断（睡眠标签页唤醒换渲染进程/丢弃/抢占）此前报出「调试器已附加，但初始化失败：未附加」的自相矛盾文案，把模型带进八步野雁追逐——现在一次完整自愈循环（强拆→重附→重 enable）吞掉瞬时死亡，仍失败时报错携带现场（标签页存在/浏览器层会话/持有者），一条错误即可定位根因。
- **video_index fetch 双通道回退**：页面通道（带登录态）一抛错整链即死、直连通道从未有机会——现改为页面通道失败自动回退直连（扩展上下文 fetch 不依赖调试器），双败合并报错两边原因；fetch 宿主优先 `/video/BV` 页而非列表序第一个 B 站标签页。
- **重复调用提醒豁免陪看采样器**：`sense_now watch` 同参每次返回新帧，合法连击被判「原地打转」并以伪用户消息打断——加入重复链豁免。
- **会话标题剥离指令标签回声**：模型把「Session Title: 」等标签回声上标题行（含加粗包裹与双重回声），双标题 provider 输出面统一剥离。

## [0.7.0] - 2026-11-21

### Added

- **实时陪看（`sense_now`）**：Agent 对用户当前窗口做有界连续采样——每轮 `watch` 约 4 秒 4 帧（尊重 captureVisibleTab 2/s 配额），32×18 亮度网格差分留帧（calm/normal/dense 三档阈值 + 硬切尖峰恒留 + 首轮首帧必留），保留帧拼成一张拼图经附件面提交为图片证据；「无显著变化」如实返回，`say` 参数的话术随结果进会话轨迹。阻塞式 watch 的队列模型改造：agent 连续调用保持陪看。帧采集经 `dsh-sense` 通道由 Service Worker 执行（offscreen 文档解码画布）；「网页截图」能力闸与模型图片输入声明双重门禁前置。修复 offscreen 隐藏文档 `new Image().decode()` 永不 settle 的问题（改 `fetch` + `createImageBitmap`）。
- **字幕优先长视频索引问答（`video_index`）**：B 站视频零下载建索引——官方 CC 字幕优先、AI 字幕走页面主世界通道（带登录态），无标签页时回落直连白名单端点（仅 `api.bilibili.com` / `aisubtitle.hdslb.com`，https + 拒 userinfo）；全片按 5 分钟 chunk + 20 秒重叠切分，utterance 以中点归属并铸稳定证据号；确定性查询路由（整片概览 / 时间词定位 / 关键词检索，时间词按片长换算「片尾」「第 N 分钟」），返回 `[mm:ss–mm:ss] 台词 (EVID_x)` 引用行并在预算截断时如实标注。索引发布以 catalog.json 后写为提交标记，存于 OPFS。视频无可用字幕时仍可索引并诚实降级。
- **画面证据（`zoom`）**：按时间点截取真实视频画面——复用/导航/打开视频页标签页，固定模板 seek 表达式（仅插数值）+ CDP 截帧，经附件面持久提交（路由图片输入声明 + 字节上限门禁全前置），返回图片块并写入索引的帧证据库（`FRAME_%06d` 引用号，status 可查条数）。「网页截图」能力未开启时如实拒绝。
- **路线 B 伴生服务（`sense-companion.mjs`）**：零依赖 Node 脚本把 Sense Now 满血引擎包装为本机 MCP Streamable HTTP 服务端——`node sense-companion.mjs [--port 8767] [--sense-now <仓库根>]`；`sense_status` 探测 node/ffmpeg/sense-now 可用性，`sense_video_index` 经 `createVideoIndexTool().route` 提供完整 Sense Now 动作面（FFmpeg 抽帧/内嵌字幕/ASR/说话人分离，`--sense-now` 指向仓库根即可，引擎零运行时依赖）。扩展经 MCP 面板挂载后 `mcp__sense-companion__*` 工具进模型工具面。所有响应携带 CORS + Private-Network 允许头（扩展页 fetch 127.0.0.1 的 Chrome 预检要求目标显式应答）。
- **「服务」独立面板（与用户插件同级）**：DeepSeek 账号、凭证、MCP 服务器、定时任务与「关于」（版本+检查更新）从「用户插件」面板拆出，成为独立面板——全页模式 rail 新增「服务」行（更新提示圆点随「服务」行走），窄侧栏经用户插件面板底部「服务与凭证」入口行进入；两侧面板与工具详情 aside 三态互斥。用户插件面板仅剩插件名册、AI 生成与内置能力管理。
- **队列一等体验（运行中发送排队/插话）**：Agent 运行中发送的消息现在明确进入引擎的持久队列（durable next-turn inbox），当前任务完成后自动按序消费——此前该链路在引擎里就绪但 shell 从不传 mode、也无任何反馈。composer 在 running 时「发送」与「中断」并存（发送钮按「繁忙时的发送行为」设置语义变化：排队/插话），发送即提示「已加入队列…」；设置项「繁忙时的发送行为」从死设置变为真实生效（steer = 插话进正在运行的步骤）。队列的查看/移除/编辑在能力面板的队列区（有队列时面板自动出现）。
- **本地文件夹工作区（Agent 真实读写）**：全页模式左栏新增「工作区」入口——选择一个本地文件夹后，引擎把它的句柄挂为虚拟 `/local/` 目录，Agent 的全套文件工具（read/write/edit/patch/glob/grep/cd）直接读写该真实目录（写/改照常经审批闸门）。实现为装饰层：OPFS 提供者的根句柄被包装成「真根 + 虚拟 `local/` 子目录」的合成根，文件工具与工作目录服务零改动；句柄经 IndexedDB 在可见页与引擎间共享（Chromium 的 Port 消息无法传句柄）。浏览器重启后句柄授权退化，rail 行显示「重新授权」一键补授；未挂载/未授权时 `/local/` 是空的拒绝占位目录，`ls /` 不受影响。
- **左栏视觉节奏整理 + 尺寸自适应**：设置入口在 rail 中改为带标签的标准行（「⚙ 设置」，与「用户插件」同款形态，slot owner 加 `labeled` 变体区分挂载点）；区块间距/label 上距统一；会话搜索框改填充式（30px、去描边）；未选中会话标题去粗体（选中态保留强调）；窗口 ≤640px 时 rail 收窄 200px，rail 容器 `box-sizing:border-box` 使设计宽度即视觉宽度——400/800/2000px 三档实测无横向溢出。
- **设置改为手机式根菜单 + 逐级进入**：新增扩展自有 settings 根模块（`extension-settings-root` 静态行），从 roster 摘除三端共用的 ui-settings-general client bundle——桌面/web 零影响。设置弹层变为 iOS 设置式根菜单（通用设置/模型/内置插件/Agent 预设四行：图标·标签·箭头），点入二级页（‹ 返回），内容区仍渲染上游各 section 组件（模型/内置插件/Agent 预设由各自 roster 行经 slot 流入；通用 section 由新模块注册上游原组件）。权限行的「不可用」路由错误长文案在扩展侧隐藏（行内控件保留）；「显示代码工作视图」开关一并移除——其写入链依赖本宿主引擎未挂载的 `ui-settings` 模块表单 face，在任何构建里都无法保存（扩展轨迹视图为自研，不读该偏好）。侧栏 header 与全页模式 rail 的设置入口观感不变。
- **独立设置页**：`settings.html` 与侧栏共用同一 boot，按文档路径自动进入全页姿态并展开设置根菜单，关闭后留在全页会话壳。模型二级页的供应商卡保持上游紧凑单行形态（早期通用行样式覆盖误命中 rowCard/rowHead 类名导致卡片拉伸、编辑按钮出界，已把该覆盖收紧到通用页行容器）。
- **全页模式（`?view=full`）：浏览器全屏使用，布局对齐 dsh 桌面客户端**。侧栏 header 新增「在新标签页打开」按钮，`sidepanel.html?view=full` 以普通标签页直开（F11 或侧栏「全屏」按钮进入真全屏）。全页姿态渲染 dsh 式左栏（brand、新会话、用户插件/设置导航、工作区、会话搜索列表——重命名/两击删除/清空全部与 header 菜单同一套 handler、全屏 toggle）+ 中央空会话 hero（品牌欢迎卡与 composer 居中构图，首条消息后自动退回常规布局）。不引入 ui-layout/ui-sidebar/ui-workspace bundle（root 槽位已被扩展壳声明、多工作区服务流缺位）；窄面板姿态零变化（stage 包裹层以 `display:contents` 保持原布局）。

### Changed

- **图片证据提交抽出共享缝（`image-evidence.ts`）**：zoom 与陪看的图片块提交统一走同一路由门禁 → 字节上限 → 附件持久化管线（page_screenshot 纪律：门禁全前置，拒绝不留半截附件）；输出 schema 与 OUTPUT_SCHEMA 严格对齐（additionalProperties 校验在真机才暴露）。
- **组合行顺序修正**：`chrome-video-index-tool` 原排在 browser provider 行之前，apply 期急切取 `ctx.browser.provider`（无 provider 时 getter 抛错）导致行挂载被引导循环 warn 吞掉、工具面缺失（单测全绿、真机才暴露的「unknown tool」）。修为惰性取 provider（调用期解析，同 user-plugin-tools 先例）并把组合行挪到 provider 行之后——真机请求体 tools 65→66 实证。
- **探针基建**：`run-all.mjs` 家族扩至 14 项（+`video-index` / `sense-now`）；`video-index-probe.mjs` 三场景（真 B 站 index 链 + OPFS 落盘 / 预播种 query 链证据行 / 真实视频页 zoom 截帧 + 帧证据索引）；`sense-companion-e2e.mjs` 覆盖挂载→调用→卸载全链；`resolveLiveBvid` 热门榜候选逐个 view API 预校验（死回退 BV 不再进探针）。
- **全页空会话欢迎页放大铺满**：欢迎构图原先沿用窄侧栏的紧凑尺寸（56px 图标 / 320px 示例行），在全屏视口里缩成中央一小块。全页模式现在整体放大——96px 品牌图标、30px 标题、640px 示例行，径向光晕同幅扩展；输入框保持与对话期停靠 lane 相同的 760px 宽度，首条消息发送后输入框不跳宽。窄侧栏形态零变化。
- **右键菜单「进入首页」**：工具栏图标的右键菜单项由浏览器固定的「扩展选项」改为自定义「进入首页」——一键打开全页工作台（`contextMenus` 权限为本次唯一新增；`options_ui` 声明随之移除，`settings.html` 仍可从左栏设置或 URL 直达）。
- **能力面板默认隐身 + 卡片化对齐输入框**：底部折叠条默认折叠，面板无内容时整条自动隐藏（有目标/待办/待审批时照常出现）；全页 hero 相位（空会话欢迎页）下彻底不渲染。形态由横贯全宽的 border-top 条改为与输入框 capsule 同材质的圆角卡，且经同几何 lane 与 capsule **同宽同边界**（dl=dr=0 实测）。空会话 hero 判定同时修正为「未开始对话」——新建会话的引擎启动事件不再挡住欢迎页。hero 构图重心上移，对齐原生 dsh 桌面。

### Removed

- **出厂 Agent 预设收窄为三个**：`deal-hunter`（购物比价员）、`video-ops`（视频号管家）、`form-runner`（表单填写员）从随扩展名册移除；`web-research`/`page-monitor`/`dev-probe` 与用户自建预设不受影响。默认预设指向已移除 id 的会话回落「默认」引擎预设。
- **模型设置移除「智谱」（BigModel 直连）预设行**：`zhipu` provider 退出出厂名册，「智谱 Coding Plan」（`zhipu-coding`）保留。此前把引擎切到 `zhipu` 路线的用户在下次启动时由 stale-route 自愈回落 DeepSeek 默认；需要直连 BigModel 的场景经「添加模型提供商」手工声明同一端点即可。

## [0.6.4] - 2026-11-17

### Added

- **DeepSeek 账号登录进浏览器宿主（B4 对齐收口）**：授权会话（PKCE）+ 账号 Host 挂进扩展组合；平台 OAuth 回调只收回环 origin（`auth_init` 对 web origin 直接 `PAYLOAD_SCHEMA_MISMATCH`），浏览器宿主无法绑端口，故以固定回环 `http://127.0.0.1:47099` 注册 redirect_uri，由 declarativeNetRequest 规则把平台跳转重定向到扩展内中转页，再经 web-server shim 送进上游账号 Host 的 `webserver/request` 瀑布——host/path/timing-safe state 校验与 PKCE 交换全部是上游原码。上游 `packages/credentials/deepseek-account` 保持零 diff。
- **面板 DeepSeek 账号卡**：`用户插件` 面板新增账号区块——状态轮询、登录（开授权页+相位行）、取消与退出登录；`account.state/startSignIn/cancelSignIn/signOut` 四个桥 RPC 以懒解析挂载（可选 seam 不钉 pending）。

### Fixed

- **模型切换不再报「no context capacity」**：扩展自写的 Anthropic 适配器把上下文容量答成了契约外的顶层 `contextWindow` 字段（`LlmResolvedModelInfo` 的契约字段是 `context: { contextWindow }`），normalize 静默丢弃后 compaction-basic 在每次切到 anthropic 路线 preset（如智谱 Coding Plan）时都以 "no context capacity" 拒绝切换。容量现按契约形状返回，并带回归测试断言压缩器实际读取的字段。由于形状经 `Promise.resolve` 泛型推断丢失新鲜度，TS 多余属性检查不触发——此类契约形状错依赖回归测试拦截。

## [0.6.3] - 2026-11-17

### Added

- **PTC 程序模式（run_code）落地浏览器宿主**：引擎新增沙页 PTC 运行时——程序在 manifest-sandboxed 的 iframe 里以 async 函数体执行（该页是扩展中唯一 CSP 允许间接求值的页面），宿主绑定经 binding-call/binding-result 消息对回环，控制台逐行捕获，超时与中止通过 iframe 重建硬停。面板「用户插件 → 内置能力」新增 **PTC 程序模式**开关（默认关）：开启后下次引擎启动组合 `run_code` 程序执行器替代原生直调执行器——模型写一段 TypeScript 程序批量编排全部工具，即桌面 `demo:ptc` 的部署姿态。运行时契约与桌面一致（预算、中止、失败分类、无损 JSON 完成值校验），差异记录在模块文档（隔离基座为 `sandboxed-iframe`，cwd 接受但不使用）。

## [0.6.2] - 2026-11-17

### Added

- **Model-facing file discovery joins the browser harness**: `glob` and `grep` — the desktop's ripgrep-spawned search suite — now run over the extension's OPFS filesystem. A `chrome-fs-search` plugin walks the origin-private tree directly (no subprocess seam exists in a browser), keeping the desktop contract for tool names, parameters, output values, and caps, with two seam-forced deviations recorded in its module doc: path-ascending order instead of modification time, and a narrow-the-search footer instead of spill-file recovery for over-cap results. VCS metadata directories (`.git` and friends) are pruned from both tools' walks.
- **Session working-directory tooling and fork subagents arrive**: the base profile's `tool-working-directory` row (the model-facing `working_directory` read/cd tool over the existing service) and the `subagent-fork-in-process` pair (an in-process fork provider whose children seed from the parent's completed-turn prefix, exposed as the `subagent_fork` delegation tool) join the offscreen composition, closing two of the audited gaps against the desktop base profile.

## [0.6.1] - 2026-11-16

### Fixed

- **The Models page can save API keys again**: every save from the model-provider settings failed with "此方法在扩展宿主中不可用：credentials/set" because the client surfaces speak the harness protocol's slash methods (`credentials/set`, `credentials/unset`, `credentials/describe`) while the extension bridge only answered its own dot-spelled RPCs. One implementation now answers both spellings, and the credentials service's commit events fan out to the panel under their harness names (`credentials/reference-updated`, `credentials/record-updated`), so the Models page, model selection, web search, and account surfaces converge their credential badges without polling or a reload.

## [0.6.0] - 2026-11-15

### Added

- **Timed-task automation**: the schedule service and the `schedule_create/list/view/edit` reminder tools join the offscreen engine — say "15 秒后提醒我…" and the model files the task; when it comes due the reminder is delivered into the target session and drives a fresh model turn on its own. The task store rides the chrome-backed storage domain (probe-verified against the layout that killed the 0.5.x projection-cache row). The 用户插件 panel grows a **定时任务** card: catalog roster with status chips and next-due times, quick-create, per-row run/pause/delete, and polling — the desktop schedule card hangs on slots this shell does not consume.
- **Panel management surfaces for both automation planes**: the MCP 服务器 card and the timed-tasks card drive the engine over new `mcp.*` and `schedule.*` RPC families (catalog/create/edit/run/delete), replacing desktop-only slot surfaces with shell-native cards.

### Fixed

- The MCP stdio transport compiles to a refusing stub (no browser surface can spawn the child process it needs), and both schedule packages carry a `./runtime` export so the extension program imports the built seam without dragging the service source's desktop API chain into its composite type check.

## [0.5.9] - 2026-11-15

### Added

- **The MCP server fleet is mounted**: the rc.3 base freed the composition deadlock that parked the earlier attempt, and `mcp-manager` + `mcp-resources` now sit in the offscreen engine. Add a `streamable-http` server from the 用户插件 panel's new **MCP 服务器** card (URL plus optional headers JSON) and its tools join the model's roster as `mcp__<server>__<tool>` — the real-machine probe drives a mock server end to end: add, connect, probe, the model request carrying the server's tool, and removal withdrawing it. Headers accept `${credential:REF}` templates resolved at connection time through the stored credentials — a missing value parks the server in a waiting state and restoring the value reconnects it automatically (probe-verified chain). Only streamable-http servers can run here: the stdio transport spawns a child process, which no browser surface can do, so the form does not offer it.

## [0.5.8] - 2026-11-15

### Added

- **Aligned with upstream 0.2.2-rc.3 (1,371 commits merged)**: the engine, client kernel, and tool seam all follow the rc.3 base now. The most user-visible piece the upgraded base brings the extension is a **much wider browser-operation tool family** the already-mounted browser package now ships — element-addressed `page_click`/`page_type`/`page_evaluate`, `page_navigate`/`page_scroll`/`page_press_key`, `page_snapshot`/`page_extract_text`, durable `page_screenshot` and `page_attach_screenshot`, `page_network` capture, `page_back`/`page_forward`, plus tab management (`tabs_open`/`tabs_switch`/`tabs_pin`/`tabs_mute`/…) and window focus/list — 27 tools on top of the previous surface.
- **Session-status service row**: the rc.3 conversation UI waits on the `uiSession.sessionStatus` service at mount; the provider module rides along so the conversation plane stays one waiting chain instead of eleven. The sidepanel now stages 48 client bundles.

### Fixed

- The whole post-merge migration debt: fork config paths and subpath exports the merge silently dropped, the provider failure codes the tightened LLM error union rejected, the rc.3 API moves (`parseEntryYaml`, symbol-keyed `Context.root`, typed subagent codes, `ToolArgsError` file-path checks), and the frozen sidepanel roster synced to the rc.3 package declarations. The upstream workflow archive is refreshed to the rc.3 snapshot, and the persistence history's parallel timeline-priority record is re-derived on top of the fork's own so the chain verifies linearly.

## [0.5.7] - 2026-11-10

### Fixed

- **The silently-failed projection-cache row is removed**: 0.5.6 shipped the session projection cache mounted into the extension engine, but its domain open fails against the extension's chrome KV backend (the upstream base routes the domain to the json backend's per-record disk layout, which the browser cannot mirror), so the row has been silently sitting in the FAILED state since 0.5.6 — invisible to every health check because the offscreen engine's loader states were outside their view. The row is now honestly pruned; restoring it needs either a kv-capable route in the chrome backend or a browser-native persistence domain, both tracked for later.

## [0.5.6] - 2026-11-09

### Added

- **Seven engine capabilities the upstream base ships and the fork lacked**, mounted from the systematic engine-composition sweep: the **`/compact` slash command** (manual compaction, alongside the already-mounted compaction-basic); the **compaction enhancers** — image-offload repairs provider `IMAGE_OFFLOAD_REQUIRED` failures in-session and the tool-result pruner keeps long browser sessions' token economy; the **session projection cache** (projection state persists across engine restarts); **tool-subagent-control** (`list_agents` / `wait_agent` / `interrupt_agent` — the model can manage its own concurrent children); and the **agent-team pair with Team mode on by default** — every new session gets the shared task board (`team_task_create/list/get/update`) and the TEAM_POLICY guidance, so model-side team orchestration works out of the box. The always-on default is a deliberate fork choice: upstream defaults Team off because its desktop settings plane offers a per-session toggle, and the extension carries no settings UI for it.

## [0.5.5] - 2026-11-09

### Added

- **The update check runs itself**: the plugin panel reopens onto its cached outcome (a newer release shows in the 关于 row immediately, no click needed) and auto-checks at most once a day; the user-plugin trigger in the header grows an amber dot while a newer release exists, and its label says so. Timeout failures of the check now say the current network may not reach GitHub instead of a raw signal error.

## [0.5.4] - 2026-11-08

### Added

- **An 关于 row with a release update check** in the user-plugin panel: unpacked installs never auto-update, so the panel now compares its manifest version against the latest published release tag (read-only GitHub API, no token) and links to the release page when a newer zip exists. The comparison lives panel-side — the offscreen page has no `chrome.runtime.getManifest`.

### Fixed

- The engine roster's `backgroundMode` config key removed: 0.2.2's tool-subagent schema has no such field (unknown keys are stripped silently), and no mounted tool starts background jobs — so the earlier ui-jobs prune stays permanent.

## [0.5.3] - 2026-11-08

### Fixed

- **The transcript no longer renders time-context sampling injections as user bubbles**: the time-context plugin's per-turn time reading is a model-visible context injection (`user/message` with the `time-context` source kind), but the panel's transcript drew it as the user's own blue bubble. It joins the runtime-context and skill-catalog kinds in the session-history filter, so the transcript and the `/export` markdown hide it through the same read. A capability-panel seat sweep (real turn, rendered slot tree, console capture) verified the newly activated session-scoped seats render with zero slot errors and walked the 对话/轨迹 views clean.

## [0.5.2] - 2026-11-08

### Changed

- **Upstream synced to 0.2.2-rc.1**: 260 commits absorbed — the 0.2.2 release candidate itself, vendor upgrades (cordis 4.1.0, cosmokit 1.9.0), the web prompt-retry fix, an inspector crash fix, and the desktop channel-policy work. The upstream session-log export header restructured onto the context-menu registry (the extension carries that module since 0.5.1, so the export gestures ride it unchanged); the settings-models panel's provider directory reads the now-synchronous llm surface. The fork's persistence acknowledgements were re-recorded through the official `--update` flow so the fork's browser-source record descends from the upstream retry record honestly (the two had been siblings claiming the same predecessor across the merge).

## [0.5.1] - 2026-11-08

### Fixed

- **Every capability-panel row activates again**: the boot audit's eleven inactive entries are gone. The shell's layout stub covers the whole 0.2.2 `ILayout` face (`panelInfo`, `selectPanel`, `beginNavigation`, `openRightbar`/`closeRightbar`) with single-panel semantics, so `ui-sidebar-right` stops crashing on the missing `panelInfo.subscribe` and its `sidebarRight`/`sidebarRightTabs` services unblock the eight rows waiting on them (plan, schedule, skill, subagent, reference, deliverables, sidebar files, document preview). `ui-file-drag` is carried with its `ui-layout` edge pruned — its `fileDrag` service unblocks the attachment strip and document preview. `ui-jobs` (and with it `api-job-controller`) is pruned honestly: it renders from `job/list`/`job/follow` typert streams, and the connection's stream leg parks every endpoint but `$events`, so the row could never activate here — background-queue visibility stays with the shell's own queue dock.
- **The session export surface works again on the 0.2.2 base**: the capability panel's session header renders once more (the shell now retains the selected session under the `mainView` label upstream's ui-workspace navigation owned, so session-scoped seats leave the hero phase), the 0.2.2 header no longer crashes on its missing `useContextMenu` hook (`dsh-client-ui-context-menu` is carried; only its `ui-layout` edge is pruned), the header's 下载/复制 Markdown gestures read the durable log over the bridge RPC through a new `sessionLogExportOverrides` carrier seam (an extension page has no HTTP host behind the plugin's `/api/session.*` routes), the root overlay seat (copy toast, context-menu root) renders, and the export read follows the 0.2.2 `session.history` page shape (`{ events: [{ event }] }`) — the composer's `/export` had silently gone empty under the pre-sync shape.

## [0.5.0] - 2026-11-08

### Changed

- **Upstream base synced 0.1.5 → 0.2.2**: the engine and package corpus absorbed two months of upstream work — a new browser-operation stack (browser-use, computer-use, CUA drivers), the PTC runtime replacing the code-runtime/e2b pair, SSH remote sessions, the plugin market and manager, the official agent-team, telemetry/OTel, speech-to-text and voice input, the DeepSeek account family, and roughly thirty new settings panels — while every fork capability (the self-built browser stack, the OPFS/apiproxy/IndexedDB extension base, the extension panels, the landing site) is preserved on top. The session format moved to v4; the reflection guard, tool-gate, and slash-menu contracts all follow the 0.2.2 shapes.

### Added

- **Approval waits reach outside the sidebar**: a pending approval or question no longer dies silently after the sidebar closes — the wait holds with no time bound, announces itself with a toolbar badge and a system notification, and the notification route reopens the panel to answer. Long-running composer slash commands report "running in the background" instead of misreading the timeout as a dead service (and the command text is no longer fed to the model), a first-install panel gets the slash menu back (discovery falls back to the global command registry), the welcome card teaches the real Enter-to-send shortcut, and pasting or dragging images into the composer attaches them directly. See `.agents/notes/implemented/feature/2026-10-27-extension-wait-visibility-and-composer-feedback.md`.
- **Accuracy, speed, and reflection batch**: `page_click` verifies hit quality before dispatching (occluded/off-viewport targets fail with the reason instead of a silent coordinate re-click), index addressing resolves and validates the cached element on-page (stale snapshots fail loudly; navigation invalidates the cache), snapshots gain a prep pipeline (动画冻结/横幅清理/懒加载, token-skipped on unchanged documents) plus 快照精简, navigation settles on `readyState` after a swap-window gap, and a new 反思守护 plugin injects failure-reflection context and a completion check so thin turn endings get one goal-directed nudge (plan-mode exempt, budget-capped).
- **Ten more built-in capability switches** (the 内置能力 section now holds 15): 快照精简 (drop long passive text from snapshots — token saver), 横幅遮罩清理 (auto-accept consent banners before snapshots), 懒加载触发 (pre-snapshot scroll sweep), 动画冻结 (kill animations for deterministic clicks), 链接净化 (strip utm_*/fbclid/gclid tracking params on navigation, default ON), 导航智能等待 (readyState settle after navigate, default ON), 禁媒体加载 (block image/video loads on attached tabs), 埋点屏蔽 (no-op navigator.sendBeacon), 危险操作确认 (danger-word clicks require approval even under full access), and 自动提交拦截 (page_type never presses Enter — the user submits manually).

### Fixed

- Browser operations stop failing silently at their edges: scroll-settle timeouts re-read the actual scroll position instead of assuming zero movement (no more double scrolls), the first CDP command waits for an in-flight debugger attach instead of racing the virtual pointer, `type_text` deadlines scale with text length × humanized pacing (long inputs no longer hit a fixed 30-second wall), read-back for skipped elements checks the focused element instead of reporting blind success, and wait/settle/scroll polling checks immediately instead of paying one idle interval first. See `.agents/notes/implemented/bug-fix/2026-10-27-extension-browser-op-correctness.md`.
- The reflection guard now fires in real browsing flows: consecutive-failure counting resets per tool bucket with witness read tools transparent (a suggested `page_snapshot` no longer washes the count), completion checks steer at most once per distinct evidence (recovered failures and honestly-reported blockers no longer loop the nudge until the budget burns), an honest "unrecoverable" turn ending counts as complete, and the guard's wiring (plan exemption, abort short-circuit, budget exhaustion, block branch) is pinned by a loaded-wiring spec. See `.agents/notes/implemented/bug-fix/2026-10-27-extension-reflect-guard-composition.md`.
- The landing screenshots' tab selector no longer shows mojibake: the fixture site behind the panel shots served UTF-8 pages without a charset declaration, so the browser sniffed a legacy CJK encoding for the tab title baked into the captures. The fixture now declares `<meta charset="utf-8">` and all three panel shots were re-captured.
- The documentation site's dark/light appearance switch now works on the landing page: the home route had pinned its dark palette unconditionally, so the toggle changed nothing there. Landing colors moved into a per-mode `--landing-*` token layer — dark mode unchanged, a new light surface (white ground, ink hairlines, indigo accents) added — and the hero orbit artwork re-palettes with the mode. See `.agents/notes/implemented/feature/2026-10-12-landing-follows-appearance-toggle.md`.

## [0.4.0] - 2026-10-09

### Added

- **Site learning (`/learn-site`)**: one slash command mechanically learns the current tab's site — a dedicated learning tab crawls same-origin sub-pages (zero model calls), condensing paths, forms, and stable CSS selectors into a per-host cheat sheet saved as a user plugin (`site-<host>`, toggleable). While a learned host is the active tab, the sheet is injected as model context, so the agent operates by known selectors instead of repeated snapshot exploration. See the browser-automation guide's 站点学习 section.
- **Clear-all sessions**: the recent-sessions menu gains a two-step 清空全部会话 footer (running sessions block with one actionable notice), and the per-row rename/delete affordances rest half-visible instead of hover-only.

### Changed

- **Trajectory view redrawn**: a left timeline spine with per-card node dots, white bordered cards with colored type pills, tool call and result merged into one card (`参数 → 结果` + duration + failure coloring), 仅工具调用 assistant slots kept as dimmed cards, a 轮次/调用/时长 chip toolbar, and an 输入/模型/工具 swimlane strip folded from event timings.
- **Composer dropdowns span the panel width**: the model, reasoning-effort, usage, permission-mode, and preset popovers drop their fixed width caps and share one left/right alignment with the composer capsule.
- The documentation site's landing page is redrawn with a generative orbit-pointer hero artwork and a full content arc (stats, how-it-runs, three design rows, preset gallery, closing call to action).

### Fixed

- Machine-input injections no longer render as chat bubbles: the skill catalog reminder is filtered from the panel history face (the durable log and model path are untouched), and a loaded skill's instruction body folds into a collapsed SKILL row instead of a raw `<skill_content>` message.
- Slash commands work from the fresh-session start: the menu opens there (discovery borrows the most recent existing session) and executing a picked line mints the session first instead of falling back to a plain model send.
- Long-running slash commands no longer get misread as a failed service at the 10-second transport timeout and sent to the model as plain text (`commands/execute` now carries a 120-second settlement budget).

## [0.3.0] - 2026-10-07

### Added

- **Site distillation (炼化)**: a new `page_network` tool captures a tab's network requests (start/read with URL and resource-type filters), so the agent can discover a site's data endpoints instead of reverse-engineering every interaction through the DOM. The extension seeds a 炼化站点 recipe skill on boot: a four-phase pipeline (explore → condense → write a site skill → verify against the live site) that turns repeated site tasks into one-call fetch recipes.
- **Timed questions**: `ask_user_question` ships the timed mode in the extension composition (120-second default window) — a question whose answer window expires settles as a pending result while the agent keeps working, the SidePanel card clears automatically, and a late answer arrives as a new turn. The blocking behavior remains one config row away.

## [0.2.2] - 2026-09-28

### Changed

- The packaged manifest description and the toolbar tooltip carry the product name (OpenBrowserHarness) instead of the internal "dsh" shorthand, matching the store listings.

## [0.2.1] - 2026-09-28

### Added

- **Delete historical sessions from the conversation switcher**: a session can be removed in place from the switcher, and its local IndexedDB log is cleaned up with it.

### Fixed

- A model pick on the fresh-session start view persists as the default instead of erroring.
- The panel opens on a fresh session; opening an old session is an explicit pick from history.
- Reasoning-effort switching works end to end — metadata, wire thinking, and composer unwrapping.
- The active session is warmed at mount and send RPCs are sized for cold resume.
- Pre-v2 assistant settlements in old session logs are repaired at open.

The fixes above were already part of the `extension-v0.2.0` release zip; they are documented here for completeness.

## [0.2.0] - 2026-09-13

First public cut of the project as an independent fork of
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`,
forked at `0.1.0-rc.5`). Everything below is relative to that upstream point.

### Added (0.1.5 sync & shell redesign)

- **Upstream 0.1.5-rc.2 convergence**: the full upstream delta merged and
  made green — unit suite 22,818 passing, typecheck clean on both compiler
  faces, and the CI lint gate at zero errors.
- **Extension boot graph rebuilt for the 0.1.5 loader**: the
  `__ModuleLoader__` bootstrap facade installed from the panel entry, one
  application batch per staged bundle, static shell/connection rows
  registered through the live loader, the connection module rebuilt on the
  generation-source contract, and a `ctx.uiWorkspace` stub keeping the
  0.1.5 conversation inject satisfiable without desktop workspace chrome.
- **Roster rebuild**: 45-module browser roster regenerated from the 0.1.5
  `dsh.client` metadata (adds approval/attachment/session/reference/
  sidebar-right/schedule/resources and the `api-*` controller rows; drops
  the removed `client-runtime` in favor of `ui-renderer`).
- **Welcome redesign**: vertically centered empty state with an ambient
  brand wash, 56px gradient brand glyph, icon-tiled suggestion cards with
  hover arrow affordance, kbd-capped shortcut hint, a primary new-session
  pill, and a gradient send button — light and dark themes verified on
  device.

### Added

- **Browser extension host** (`apps/extension`): the full dsh engine runs
  long-lived in the Chrome/Edge MV3 Offscreen document, driven from a side
  panel (tab selector, native transcript, composer with model / thinking
  effort / permission controls, capability panel with todo/goal/queue
  surfaces, interaction cards for approvals and questions).
- **Browser capability layer** (`packages/browser`): `tabs_*` / `page_*`
  tools over `chrome.debugger` (CDP) with humanized input — Bezier mouse
  trajectories with speed jitter and landing-point jitter, per-keystroke
  typing, inertial scrolling with closed-loop residual correction,
  snapshots that pierce Shadow DOM and iframes, text-leaf collection,
  screenshots for multimodal models, and an in-page `page_evaluate`.
- **Visible virtual cursor**: CSP-safe canvas overlay rendering a neon
  comet cursor with motion trail, afterimages, click shockwaves, and
  keystroke/scroll pulses, synchronized with the input stream.
- **Extension storage seams**: OPFS filesystem provider (`packages/fs/fs-opfs`)
  and IndexedDB session persistence
  (`packages/session/session-persistence-indexeddb`) with stable session
  identity recovery and a watchdog against service-worker eviction.
- **Provider presets**: DeepSeek, Zhipu BigModel, and GLM Coding Plan
  (Anthropic-protocol with Bearer auth), plus hand-declared custom routes
  (OpenAI-compatible / Anthropic / OpenAI-Responses) with header and modality
  validation; per-preset user-added model rows.
- **Permission tiers**: ask-every-action / ask-on-changes / full access,
  per-action approval cards, and a plan-mode exit chip.
- **User plugins**: sandboxed user-authored plugins (manifest-sandboxed page,
  `new Function` confined there) with activation-failure persistence and
  last-error surfacing.
- **Skills storage** and Bilibili-style login-state probes as reusable
  snippets; time-context readings (model-facing clock/elapsed context) with
  chat-flow concealment.
- **Session-history navigation**: `page_back` / `page_forward` step a tab's
  session history and report an honest `navigated:false` at the boundary.
- **Pierce selectors**: elements inside shadow roots and same-origin iframes
  carry `seg >>> seg` selectors in snapshots; `page_type`, `page_click`,
  `page_wait_for`, clearing, and the structured-value fallback resolve them
  through one shared deep resolver (shadow-root / iframe-document descent),
  with iframe-descended rects converted to top-viewport coordinates.
- **Screenshot attachment**: `page_attach_screenshot` writes a previously
  captured screenshot into a page file input — bytes travel extension → page
  directly, never through the model; `attachment_id` defaults to the most
  recent capture.
- **Visible virtual cursor idle presence**: after a gesture the cursor rests
  at its landing point (dimmed, slow-breathing halo) for 8 s instead of
  vanishing with the tail.
- **Stale provider route self-heal**: engine boot validates the persisted
  provider against the adapter universe; a route whose custom profile was
  deleted falls back to the stock provider (persisted, loudly logged)
  instead of failing every request with `NO_ADAPTER`.
- **Goal parked-goal guardrails**: model guidance states a paused/blocked
  goal is never acted on unprompted, and the goal bar dims parked phases so
  "won't run on its own" reads at a glance.

### Changed

- Settings surfaces consolidated for the narrow side panel (full-bleed flat
  layout; the models editor folded into one panel set).
- `tool-catalog` regenerated for the browser tool schemas, including combo-key
  (`Ctrl+A`-style) `page_press_key` support and the screenshot-attach pair.
- Dark theme: the user message bubble uses a brand-tinted deep blue
  (contrast 9.5:1) instead of near-black.
- Vendored Cordis loader: `!js` YAML expressions evaluate lazily — required by
  MV3 page CSP (logged in `vendor/README.md`, modification #19).

### Fixed

Highlights of the fork-era fixes retained on top of upstream (full detail in
`.agents/notes/`): `awaitPromise` in page evaluation (async snippets used to
return unresolved); embedded tool-result images lifted to wire image parts
(screenshot → multimodal bridging); scroll gesture drop/animation-midpoint
residual correction; shadow-host snapshot coverage; iframe coordinate
addressing; `time`/`date` input structured-value fallback; session history
repair for interrupted tool calls.
