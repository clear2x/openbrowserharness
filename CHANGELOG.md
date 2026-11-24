# Changelog

All notable changes to OpenBrowserHarness are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [Semantic Versioning](https://semver.org/). Pre-1.0, anything may
change without notice.

## [0.8.2] - 2026-11-24

### Added

- **网站任务靠真实页面操作，不调用接口**：在网站上完成任何事——搜索、打开、翻页、展开、点赞、关注、评论、提交——都必须像真人一样操作页面（打开、点击、输入、滚动、读取页面呈现的内容），不再拿站点接口代替页面操作。规则写在每一轮都会读到的浏览器操作准则第一条与 `page_evaluate` / `web_fetch` 的工具描述里；提示词之外有一道硬闸：`page_evaluate` 表达式或 PTC `run_code` 程序正文里出现 fetch/XHR 等请求原语（含 `window.fetch` 别名、`fetch.bind`、`window['fetch']`、jQuery `$.ajax` / `$.get`、AngularJS `$http`、axios、动态 `import()`、为 `src` 建 `<script>`）时，工具闸在执行前直接拒绝，拒绝文案指回页面工具——完全访问模式下同样生效，程序内嵌套的工具调用经过同一道闸。检测是词法的：注释、字符串内容、正则体先抹空，只在读取页面的脚本里提到 `fetch` 不会被误拒。真机实证（真 Edge + 真模型 GLM-5.3-Flash 在真实 bilibili.com 上）：真机探针 `script-gate` 八条断言全过（默认拒绝、别名拒绝、只读放行、开关放行、`run_code` 拒绝与放行、危险操作确认关/开）；真模型以新预设完成「首页搜索框搜索 → 列出前 5 个视频 → 点开第一个视频读标题/UP/播放量 → 滚动加载评论区读热评」两轮任务，工具分布只有 tabs_open / page_type / page_press_key / page_click / page_batch_actions / page_scroll 与页面读取，脚本请求尝试 0 次、接口地址访问 0 次；真机探针族 25 项全过。
- **内置能力「页面脚本请求接口」**（默认关闭）：唯一解除上面硬闸的开关，仅当你明确要求抓取站点接口（如 `/site-api-crawl`）时才需要开启。
- **新预设「bilibili助手」**：像真人一样操作 B 站网页——在页面搜索框里搜索、点击卡片与标签页、滚动加载、读取页面呈现的文字、用播放器自己的控件操作；点赞、投币、收藏、关注、评论、发弹幕、转发、修改资料只在本次任务里明确要求时才做（投币前说明数量，评论、弹幕、转发的具体内容发出前先给用户过目；任务途中顺手可做的先说明并征得同意），登录、验证码与风控交给用户；需要逐段字幕总结长视频时，先说明 `video_index` 会调用字幕接口并征得同意。选中即开启「危险操作确认」与「提交拦截」。预设总数来到九个（四个原生模式 + 五个浏览器专长），落地页的预设卡、统计数字与截图同步更新。

### Fixed

- **「危险操作确认」开关从未在引擎里生效**：工具闸读取能力开关的读取器直接调用 `chrome.storage.local`，而 offscreen 文档（引擎所在处）拿不到 chrome.storage 绑定——读取抛错后被吞成默认值「关闭」。自该开关引入起，在面板里打开它也不会对危险词点击弹审批；同一读取器上的新开关「页面脚本请求接口」同样会形同虚设（真机探针首轮即抓到：开关已开，引擎仍按关闭拒绝）。现在读取走 `storage-client`（Service Worker 里直连，offscreen 里经后台转发），任一本地变更即时清缓存，读取失败按默认值处理并告警一次。真机回归首次覆盖这条路径：关闭时危险词点击直接执行，开启时先弹审批、允许后才执行。

### Changed

- 内置技能对齐规则：`bili-up-digest`、`site-distill` 改为页面操作配方（滚动加载、读取页面已呈现的内容），`site-api-crawl` 把开启「页面脚本请求接口」写作前置条件——三者播种版本号递增，已安装用户自动更新；`股市通` 预设的工作方式措辞同步。
- `page_evaluate` 的定位收窄：用于读取页面已经呈现的状态或用户明确要求的页面改造，不是操作网站的方式；`web_fetch` 用于读取网页与文档，不用于抓站点的接口。
- 商店详情（中英）补入「真实页面操作，不碰站点接口」与九个预设两条。

## [0.8.1] - 2026-11-24

### Added

- **外壳本地化（中/英）**：英文浏览器下面板的自有文案此前全是硬编码中文——输入条、对话外壳、用户插件 / 服务 / 自动化面板、预设页、端侧 AI 卡无一例外。现在这批文案全部进入带类型的字典（`apps/extension/src/sidepanel-dsh/locales/`，约 550 条中英对偶），经上游 locale 服务取值：语言跟随浏览器或在设置里选定的偏好，运行中切换即时重绘；`verify-client-ui-i18n` 门禁扩展覆盖 `sidepanel-dsh`，写回组件的文案会让门禁失败。
- **面板之外的本地化**：工具栏标题、扩展简介、右键菜单「进入首页」与等待确认通知经 manifest `_locales` 跟随浏览器界面语言（简体 / 繁体 / 英文）；OAuth 登录中转页按浏览器语言出文案；独立设置页的标签页标题随语言变化；内置 Agent 预设的名称与描述、「本地 AI」的模型标签与用途按预设 id / 模型 id 映射到字典（用户自建预设保持原文）。
- **回归网**：字典对偶（键集、占位符、各面文件键不重叠）、目录一致性（端侧模型目录与内置预设 roster 的中文逐字对齐）与「每个键都被组件引用」的单测；真实 `LocaleRuntime` 下七类面板在 en 面的渲染回归（全文无 CJK、无裸键）与 zh 面措辞回归；真机探针 `i18n-probe`（Edge 无头，en-US 与 zh-CN 双跑共 59 项断言）并入真机探针族。

### Fixed

- **上游输入框的占位符永远是中文**：启动时写入的样式表在 locale 服务就位之前就解析文案，只会落到中文回退，而且一次性写死、切换语言也不更新——改为读 CSS 变量，由外壳按当前语言实时写入。
- **英文界面里预设 chip 显示「标准模式」**：预设 roster 只带中文名，芯片、预设菜单、预设页、自动化面板都直接显示它——现在按预设 id 取字典文案。
- **英文界面里供应商显示「智谱 Coding Plan」**：供应商显示名是引擎按预设下发的视图数据（模型设置页、输入条模型菜单、自动化面板共用）。引擎现在按面板当前语言出名称：面板在启动与每次切换语言时上报活跃 locale（`ui/language`）——浏览器自动判定的语言引擎自己看不到；没有上报时回落到已存的语言偏好，再回落到浏览器语言。中文界面仍是「智谱 Coding Plan」，英文界面显示 `Zhipu Coding Plan`。
- **模型设置里四处文案绕过字典**：协议卡标题硬编码 `Chat Completions` / `Responses`，而字典里早有 `OpenAI Chat Completions` / `OpenAI Responses`（web 期望输出也是后者）；自定义路由的两个占位符与 DeepSeek 名称回退同样硬编码——全部接入字典，`verify-client-ui-i18n` 自引入以来一直失败的 6 处历史命中清零。
- **「本地 AI」卡在英文界面显示中文模型名**（`multilingual-e5-small 嵌入`）：模型标签现有英文条目。
- **中文界面里的英文残留**：轨迹卡的 `(no output)` 改为「（无输出）」。
- **MCP 服务器卡标题在英文下被挤成两行**：较长的副标题换行，标题保持一行。
- **第三方许可证声明漏了端侧 AI 的两个依赖**：v0.8.0 加入 `@huggingface/transformers`（Apache-2.0）与 `onnxruntime-web`（MIT）后没有重新生成 `THIRD_PARTY_NOTICES.md`——已补齐，生成器回归恢复通过。
- **文档门禁自 v0.8.0 起是红的**：`applyPageTools` / `fetchMetaFromValue` 的 JSDoc 缺压缩参数说明、text-extract 的 README 示例引用未定义变量、配置目录未随新配置项重新生成——四处补齐，`doc-sync` 43 项全绿。

### Changed

- 模型设置的 OpenAI 协议卡标题统一为字典措辞：`OpenAI Chat Completions`、`OpenAI Responses`（中英一致，此前卡片显示 `Chat Completions`、`Responses`）。
- 独立设置页的标签页标题由静态的「OpenBrowserHarness 设置」改为随语言（英文浏览器显示 `OpenBrowserHarness settings`）。
- 中文浏览器里扩展管理页的扩展简介由英文改为中文。

## [0.8.0] - 2026-11-23

### Added

- **端侧 AI（「本地 AI」面板，全部模型 ≤1GB、CPU 优先）**：按能力安装、推理全部运行在专用 AI worker 内——PP-OCRv4 从截取帧读取烧录字幕（无 GPU 可用），SmolVLM2-256M 生成画面描述（WebGPU），Whisper-base 把无字幕视频的音频转写进索引（`video_index index` 自动回退，≤8 分钟视频，B 站音频经页面通道直取、CDN 放行空 referer），multilingual-e5-small 驱动 `page_find_related`——按任务对页面元素做本地语义排序，大页面免翻截断快照。模型目录硬闸 1GB、hf-mirror 镜像回退、安装即自证；「最近使用」账本把每次本地推理真实记入轨迹（时间/能力/模型/耗时/摘要）。
- **按本机速度节拍的本地转写**：本地 Whisper 的速度取决于机器（实测 Apple Silicon 约 2.8 倍速，慢机器可慢到低于实时），只靠「≤8 分钟」的时长上限保证不了有界的等待——慢机器会把时限烧光还一无所获。现在音频按约 60 秒一段转写（切点落在最安静的瞬间，不切断词），每段完成后用实测速度推算下一段能否在时限内完成，完不成就停在已转写处并**保留已有成果**。索引记下转写覆盖到第几分钟，`index` / `status` / `query` 的输出都明说其后未转写，模型不会把「没转写到」当成「视频里没讲」；时限是配置项（默认 300 秒）。「本地 AI」使用账本逐次记下取流 / 解码 / 转写三段耗时。真机实证（真 Whisper、真 B 站 6 分 48 秒音频）：8 秒预算恰好做完第一段即停（覆盖 0:59、`truncated=true`），默认预算跑完全片（234 条原始台词、末条落在片尾）。
- **抓取/渲染抽取式压缩**：超长页面文本在进入模型前按信息量裁剪（词频+CJK bigram 打分、标题必留、冗余闸 0.6、尾部保底）——同 4000 字符预算下保住标题与高密度句，模型少一次「再取后半段」的往返。`page_extract_text` 超长文本默认启用。
- **批量页面操作（`page_batch_actions`）**：把一整段页面操作计划（click / click_at / type / press / scroll / wait / navigate，≤12 步）合并为一次调用，替代多轮 page_* 往返——计划先整体校验再运行、任一步失败即停止并回报逐步进度。批量 lane 自带单步流程靠模型观察节奏才有的可操作性：每个点击/输入目标先自动等待出现（默认 5 秒，可配置）并滚动到视口内；每个可变步骤在页面上打一个「文档标记」，标记消失即说明该步引发了跳转，等到新文档可交互才跑下一步（`document.readyState` 在跳转提交前对旧文档仍读作 complete，单靠它会抢跑）；`wait` 步骤改由扩展侧短读轮询，跳转中途不再搁浅；新增视口坐标点击 `click_at`（画布/滑块等无法用 selector 寻址的目标）。
- **工具按需加载（请求体约减半）**：扩展宿主对每个会话组合同一套静态工具——69 个工具、约 4 万字符的 schema 随**每一次**模型请求重发，其中约一半是浏览器任务很少触及的套件。现在团队协作与子代理、定时任务、文件工作区、后台任务四组默认不出现在模型工具列表里，由一个很小的 `load_tools` 带目录按需放开：加载后本会话持续可用（上游以 tool-registry 的 developer/message 登记新增工具，模型可见 ⟺ 已记录）；模型若直接调用尚未加载的工具，`UNKNOWN_TOOL` 失败时当场加载所在组并附提示「请直接重新调用」。实测默认请求体 50,097 → 26,633 字符（-47%），真模型（GLM-5.3-Flash）对文件/定时任务两组都是主动 `load_tools` 加载、零浪费步。「工具按需加载」能力开关（默认开）可恢复全量；PTC 模式下始终全量（程序无法中途请求加载）。
- **真机自走回归（zhipu-e2e）**：真 Edge + 真扩展 + 真模型（智谱 Coding Plan）驱动的闭环探针——快照健康闸、批量登录链（真实 DOM 落页断言）、按需工具组（文件读写、创建定时任务）、MCP 桥控制面五场景；mock 探针族扩至 23 项（新增批量五场景：全成功链/失败即停/跳转沉降/自动等待/坐标点击；语义定位→标记 selector→真实点击；调试器三路径：正常/外部断开自愈/标签页消失的翻译报错；本地转写节拍两路径：小预算截断保留成果 / 默认预算跑完全片）。

### Fixed

- **`page_find_related` 的错点风险**：返回的 `index` 其实是相关度名次，文案却宣称是「snapshot index，可直接用于 page_click」——模型照做会点到上一次快照的 1 号元素。现在每个命中元素带唯一标记 selector（`data-dsh-find="n"`，与页面自身的 id/aria/name 属性无关），结果不再携带 index；真机端到端：find 给出的标记 selector 经 `page_click` 真实点中登录按钮。
- **page_snapshot 在产物构建上全断（「G is not defined」）**：注入模板用源码原名绑定内联函数，而 minify 改名模块作用域——函数体内互调用的是改名后的名字，页面上不存在。注入模板的绑定与调用点全部改为经 `fn.name`；回归锁扩到全部 9 个页面注入表达式（快照走查/元素重解析/点击命中探针/等待轮询/预处理清扫/输入回读/输入清空/语义定位采集器/批量目标探针）：esbuild 按产物同款 minify 拼装，TypeScript AST 静态扫自由标识符；外加一条源码级规则——任何模板都不得用字面量名字绑定序列化函数。由 zhipu-e2e 真模型探针首轮真机抓到。
- **调试器通道：自愈 + 断开原因自证**：attach 成功但 Page.enable 即断（会话在附加后被外部掐断）此前报出「调试器已附加，但初始化失败：未附加」的自相矛盾文案，把模型带进八步野雁追逐。三轮真机诊断（加载中/同源与跨站跳转/冻结/丢弃/SW 重启/多标签页/真实 B 站页面）排除了页面自身状态因素后，控制器重写为：会话死亡按退避节奏重试（0/250/750/2000ms，每次从干净会话开始）；命令发现会话已断则重新附加并只再执行一次；被休眠卸载的标签页先重载再附加；认领的会话先用探针验证再信任（旧实现凭一条可能过期的记录就会认领别人的会话）；持续失败时报错带上浏览器层现场与最近一次断开事件——`canceled_by_user`（浏览器「已开始调试此浏览器」提示条上的「取消」被点击）会明确让模型停止重试并转告用户。顺带补上 `No tab with given id` / `Cannot access a chrome:// URL` 的翻译缺口，并去掉那句模型看不懂的「请重新执行 ensure_attached」。
- **video_index fetch 双通道回退**：页面通道（带登录态）一抛错整链即死、直连通道从未有机会——现改为页面通道失败自动回退直连（扩展上下文 fetch 不依赖调试器），双败合并报错两边原因；fetch 宿主优先 `/video/BV` 页而非列表序第一个 B 站标签页；ASR 媒体白名单补 B 站合作 CDN（`mountaintoys.cn`，真机动态路由实证）。
- **本地转写通道：重复下载、无谓重试、含糊的超时**：同一段音频流被下载两次（引擎拉了一遍却不用，适配器又拉一遍）；转写超时后 worker 桥原样重试一次——转写超时是算力不够，重试只会再烧一遍预算，且第二次仍在跑时工具早已超时报错；超时报错文案只有一句「AI worker 请求超时」。现在只下载一次、转写只尝试一次，超时直说「这台设备的转写速度太慢」并给出可行替代。
- **CI 上压缩回归锁找不到 esbuild**：回归锁用相对路径 `node_modules/.bin/esbuild` 拼装压缩产物，CI 的全新安装里根目录没有这个 bin（本地能过只是因为残留了一个旧文件）——改为经扩展自己的打包器（vite）的依赖上下文取 esbuild 的 JS API，该 spec 也不再声明并不需要的 jsdom 环境。
- **`page_type` 并非真正的整体替换**：向已有内容的输入框输入时，此前先把新字追加敲进旧值（搜索框实时联想、表单校验都会对这串脏中间值触发），最后才被回读覆写；现在字段非空时先清空再敲字。
- **新开标签页在列表与结果里没有地址**：`tabs_open` 刚返回时 `url` 还是空串（地址在 `pendingUrl` 里），「已打开标签页 N：」后面是空的，按 URL 匹配标签页的通道也找不到它——现在回落到待提交地址。
- **重复调用提醒豁免陪看采样器**：`sense_now watch` 同参每次返回新帧，合法连击被判「原地打转」并以伪用户消息打断——加入重复链豁免。
- **会话标题剥离指令标签回声**：模型把「Session Title: 」等标签回声上标题行（含加粗包裹与双重回声），双标题 provider 输出面统一剥离。
- **发布工作流在 Install 步失败**：`@huggingface/transformers` 的可选依赖 `onnxruntime-node` 带构建脚本，pnpm 11 把未登记的未构建依赖当成 CI 安装错误——在 `allowBuilds` 里显式拒绝（扩展只用 onnxruntime-web）。

### Changed

- **扩展目录全规则 lint 清零**：按仓库完整规则集（90 条，含类型感知规则）扫描 `apps/extension` 的 50 个 error 全部修复——端侧 AI 推理结果在库边界做运行时收窄（不再把 `any` 一路带到调用点）、异步占位方法改为显式 `Promise.reject`、多余断言/转换、面板里的 `any` 赋值等。
- **PTC 沙箱的动态编译写法**：`new Function(...)` 改为等价的 `Reflect.construct(Function, …)`（沙箱页 CSP 与设计不变），input 清空/回读脚本收敛为可单测的序列化纯函数。

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
