/**
 * Landing-page copy, one record per locale. The layout renders it; the
 * canonical hero and feature copy stays in the `layout: home` frontmatter.
 */

/** Design-row screenshots, keyed by name; `LandingLayout.vue` binds the files. */
export type ShotKey = 'chat' | 'trajectory' | 'plugins'

/** One figure in the stats strip. */
export interface Stat {
  value: string
  label: string
}

/** Glyph keys the journey cards draw from the layout's icon set. */
export type CapabilityIcon = 'model' | 'code' | 'cursor' | 'learn' | 'video' | 'redact' | 'log'

/** One capability listed under a journey stage. */
export interface Capability {
  icon: CapabilityIcon
  title: string
  body: string
}

/** One stage of a turn: the step, and the capabilities that carry it. */
export interface JourneyStage {
  key: string
  title: string
  body: string
  caps: Capability[]
}

/** One screenshot-and-copy row of the design notes. */
export interface DesignRow {
  eyebrow: string
  title: string
  body: string
  shot: ShotKey
  alt: string
  /** Short label on the figure's window bar, naming what the crop shows. */
  caption: string
  /** CSS `aspect-ratio` of the visible crop; the screenshot aligns to its top edge. */
  frame: string
}

/** One shipped agent preset. */
export interface Preset {
  name: string
  desc: string
  note: string
}

/** One question of the boundaries section. */
export interface FaqItem {
  q: string
  a: string
}

/** One card of the control section, drawing the shipped UI it describes. */
export interface ControlCard {
  /** Which mock the card renders above the claim. */
  key: 'approval' | 'tiers' | 'log'
  title: string
  body: string
}

/** The strings the control-section mocks render. */
export interface ControlMock {
  /** The pending action, its question, and the two answers. */
  approval: { tool: string; ask: string; allow: string; deny: string }
  /** The permission tiers, and the index drawn as selected. */
  tiers: { label: string; items: string[]; active: number }
  /** A few append-only log lines, and the export label beside them. */
  log: { label: string; lines: string[]; export: string }
}

/** One composer chip of the re-enacted side panel. */
export interface StageChip {
  /** Leading glyph: the model dot, the thinking bulb, the access shield, or the preset spark. */
  icon: 'model' | 'think' | 'access' | 'preset'
  label: string
}

/** Visible labels of the re-enacted side panel and browser chrome. */
export interface StageChrome {
  /** Tab title and address while the page shows its home state. */
  homeTab: string
  homeUrl: string
  /** Tab title and address once the search result has loaded. */
  articleTab: string
  articleUrl: string
  /** Session name before the first page titles it. */
  session: string
  newTask: string
  tabs: [string, string]
  chips: StageChip[]
}

/** The web page the hero stage re-enacts. */
export interface StagePage {
  wordmark: string
  tagline: string
  searchPlaceholder: string
  fromLine: string
  infobox: { label: string; value: string }[]
  title: string
  /** Lead paragraph, one entry per sentence. */
  lead: string[]
  sections: { title: string; body: string }[]
}

/** The scripted turn the hero stage plays. */
export interface StageCopy {
  /** Instruction typed into the composer and shown as the user message. */
  instruction: string
  /** Composer placeholder. */
  placeholder: string
  /** Label before each tool-call row. */
  toolLabel: string
  /** Tool names, in call order. */
  tools: string[]
  /** First line of the reply. */
  answerLead: string
  /** Numbered reply lines. */
  answer: string[]
  /** Title of the status card above the composer. */
  statusTitle: string
  /** Text typed into the page's search box. */
  query: string
  caption: string
  panel: StageChrome
  page: StagePage
}

/** Every landing string the layout renders. */
export interface LandingCopy {
  /** Suffix of the hero headline drawn in the whale gradient. */
  accent: string
  /** Whether that suffix starts a line of its own instead of running on. */
  accentStartsLine: boolean
  /** Facts under the hero buttons, each one checkable from the shipped product. */
  heroProof: string[]
  installLabel: string
  installTitle: string
  installBody: string
  installDirectLabel: string
  installDirectTitle: string
  installDirectBody: string
  installDirectCta: string
  installStoreLabel: string
  installStoreTitle: string
  installStoreBody: string
  installStoreCta: { chrome: string; edge: string }
  steps: string[]
  statsEyebrow: string
  stats: Stat[]
  controlEyebrow: string
  controlTitle: string
  controlBody: string
  controlCards: ControlCard[]
  controlMock: ControlMock
  journeyEyebrow: string
  journeyTitle: string
  journeyBody: string
  journey: JourneyStage[]
  designEyebrow: string
  designTitle: string
  rows: DesignRow[]
  presetsEyebrow: string
  presetsTitle: string
  presetsBody: string
  presets: Preset[]
  /** Where the preset is switched, shown under the selected preset's description. */
  presetsFootnote: string
  faqEyebrow: string
  faqTitle: string
  faqBody: string
  faq: FaqItem[]
  /** Closing headline, split into the two phrases that may break across lines. */
  ctaTitle: [string, string]
  ctaBody: string
  ctaPrimary: string
  ctaSecondary: string
  stage: StageCopy
}

/** The page both locales stage: the English article the recorded session read. */
const stagePage: StagePage = {
  wordmark: 'WIKIPEDIA',
  tagline: 'The Free Encyclopedia',
  searchPlaceholder: 'Search Wikipedia',
  fromLine: 'From Wikipedia, the free encyclopedia',
  infobox: [
    { label: 'Developer', value: 'Google LLC' },
    { label: 'Initial release', value: 'September 2, 2008' },
    { label: 'Engine', value: 'Blink' },
  ],
  title: 'Google Chrome',
  lead: [
    'Google Chrome is a cross-platform web browser developed by Google.',
    'It was first released in 2008 for Microsoft Windows, built with free software components from Apple WebKit and Mozilla Firefox,',
    'and was later ported to Linux, macOS, iOS, and Android.',
  ],
  sections: [
    {
      title: 'History',
      body: 'Chrome is the main component of ChromeOS, where it serves as the platform for web applications. Most of Chrome\'s source code comes from Google\'s free and open-source software project Chromium, but Chrome is licensed as proprietary freeware.',
    },
    {
      title: 'Design',
      body: 'Features include a minimal user interface, sandboxed tabs, sync with Google services, and automatic updates. Chrome introduced the multi-process architecture that isolates tabs to improve stability and security.',
    },
    {
      title: 'Reception',
      body: 'Chrome has been the dominant browser worldwide since 2012, with roughly two thirds of the desktop browser market.',
    },
  ],
}

/** Tool names of the staged turn, all shipped by the extension. */
const stageTools = ['page_click', 'page_type', 'page_press_key', 'page_extract_text']

/** Panel and browser labels shared by both locales. */
const stagePanel = {
  articleTab: 'Google Chrome - Wikipedia',
  articleUrl: 'en.wikipedia.org/wiki/Google_Chrome',
  session: 'OpenBrowserHarness',
} as const

/** Simplified Chinese landing copy. */
export const zh: LandingCopy = {
  accent: '智能体',
  accentStartsLine: false,
  heroProof: ['开源 · MIT', '无需注册账号', '密钥只存本地'],
  installLabel: '安装 · INSTALL',
  installTitle: '先给最新版',
  installBody: 'GitHub Release 跟代码同步，永远最新；商店版要过审核，版本通常落后几个版本。',
  installDirectLabel: '直接下载 · 推荐',
  installDirectTitle: '从 Releases 下载最新构建',
  installDirectBody: '解压后在扩展管理页「加载已解压的扩展程序」；更新时下载新 zip、替换文件夹即可。',
  installDirectCta: '下载最新 zip',
  installStoreLabel: '应用商店 · STORE',
  installStoreTitle: 'Chrome 应用商店 / Edge 加载项',
  installStoreBody: '一键安装、随浏览器自动更新，代价是版本受审核节奏影响，会落后于 Release。',
  installStoreCta: { chrome: 'Chrome 应用商店', edge: 'Edge 加载项' },
  steps: [
    '从 Releases 下载 openbrowserharness.webstore.zip 并解压。',
    '打开扩展管理页 chrome://extensions（Edge 为 edge://extensions）。',
    '开启「开发者模式」，点击「加载已解压的扩展程序」，选择解压后的文件夹。',
  ],
  statsEyebrow: 'BY THE NUMBERS',
  stats: [
    { value: '60+', label: '浏览器工具' },
    { value: '9', label: '预设与工作模式' },
    { value: '3', label: '权限档位' },
    { value: '100%', label: '本地会话日志' },
  ],
  controlEyebrow: 'IN YOUR HANDS',
  controlTitle: '它动手，你点头',
  controlBody: '浏览器是最诚实的界面：每一步都落在真实页面上，每一次点按都要你放行，跑完还能按时间轴逐帧回放。',
  controlCards: [
    { key: 'approval', title: '逐操作审批', body: '点击、输入、发请求，先变成一张审批卡：单次放行、本次会话放行，或者直接拒绝。' },
    { key: 'tiers', title: '三档权限', body: '每次确认、仅变更确认、完全访问——侧栏的盾牌随时升降，只读任务可以一路放行。' },
    { key: 'log', title: '仅追加的日志', body: '模型看到的每个字节都写进会话日志：系统提示、工具结果、审批决定，随时导出复核。' },
  ],
  controlMock: {
    approval: { tool: 'page_click', ask: '在当前页点击「搜索」？', allow: '允许', deny: '拒绝' },
    tiers: { label: '访问级别', items: ['每次确认', '仅变更确认', '完全访问'], active: 1 },
    log: {
      label: '会话日志',
      lines: ['tool result · page_snapshot', 'approval · page_click 已允许', 'answer · 三点总结'],
      export: '导出 .jsonl',
    },
  },
  journeyEyebrow: 'HOW IT RUNS',
  journeyTitle: '一条指令，三段旅程',
  journeyBody: '从一句自然语言，到看得见的点击，再到可回放的日志——每一段都有对应的能力兜底。',
  journey: [
    {
      key: '01',
      title: '你说目标',
      body: '查资料、填表单、盯页面变化，一句自然语言就够；用哪个模型、怎么扩展，由你挑。',
      caps: [
        { icon: 'model', title: '自选模型', body: 'DeepSeek、智谱 GLM、OpenAI 兼容、Anthropic 协议或本地 Ollama，密钥只存本地。' },
        { icon: 'code', title: '可扩展底座', body: '用户插件热加载沙箱、技能沉淀与斜杠指令；模型可代你写自动化插件。' },
      ],
    },
    {
      key: '02',
      title: '它开真页面',
      body: '拟人化输入与可见光标落在真实标签页上：多标签管理、Shadow DOM 穿透、逐键输入。',
      caps: [
        { icon: 'cursor', title: '操作真实页面', body: '贝塞尔轨迹、逐键输入、惯性滚动；经调试协议驱动，不做系统级自动化。' },
        { icon: 'learn', title: '站点学习 · /learn-site', body: '学习站点同源子页面，凝练成速查表；回到该站点自动进入模型上下文。' },
        { icon: 'video', title: '视频智能 · 实时陪看', body: '字幕优先的视频问答，按时间点作答，回答自带 EVID 证据引用。' },
      ],
    },
    {
      key: '03',
      title: '全程有迹',
      body: '模型看到的每个字节都留在本机，跑完还能按时间轴逐帧回放。',
      caps: [
        { icon: 'redact', title: '先脱敏，再进模型', body: '快照里的手机号、身份证、邮箱、卡号换成占位符后才进上下文。' },
        { icon: 'log', title: '仅追加日志', body: '系统提示、工具结果、审批决定逐条落盘，轨迹可回放，日志可导出。' },
      ],
    },
  ],
  designEyebrow: 'DESIGN NOTES',
  designTitle: '看得见的操作，留得下的记忆',
  rows: [
    {
      eyebrow: 'OPERATE',
      title: '看它如何操作',
      body: '虚拟光标沿贝塞尔路径移动、逐键输入、惯性滚动。页面由浏览器调试协议直接驱动，不碰系统级自动化——每一次点击都发生在真实页面上，可见，也可随时中断。',
      shot: 'chat',
      alt: '侧边栏里的一轮任务：指令发出后依次调用 tabs_open 与 page_extract_text，随后给出三点结论',
      caption: '对话 · 工具调用与三点结论',
      frame: '1120 / 1400',
    },
    {
      eyebrow: 'REVIEW',
      title: '每一步有迹可循',
      body: '模型看到的一切都写入仅追加的会话日志：系统提示词、工具调用与结果、审批放行、每一次上下文注入。轨迹视图以时间轴卡片回放整个回合——输入、模型与工具三条泳道让时间花在哪一目了然，日志可导出留存。',
      shot: 'trajectory',
      alt: '轨迹视图：顶部是输入、模型与工具三条泳道，下方按时间轴回放用户消息、两次工具调用与助手回复',
      caption: '轨迹 · 时间轴回放',
      frame: '1120 / 1400',
    },
    {
      eyebrow: 'SANITIZE',
      title: '先脱敏，再进模型',
      body: '快照进入模型上下文之前，手机号、身份证、邮箱、银行卡号已经换成占位符；截图不脱敏，需要核对真实号码时再关掉。学过的站点（/learn-site）凝练成速查表，只在命中的标签页注入——每个开关都能单独启停。',
      shot: 'plugins',
      alt: '用户插件面板里的内置能力开关：站点速查注入、快照脱敏、虚拟指针、拟人化输入、快照精简',
      caption: '内置能力 · 逐项开关',
      frame: '1120 / 976',
    },
  ],
  presetsEyebrow: 'PRESETS',
  presetsTitle: '九种预设，四种工作方式',
  presetsBody: '每个预设保留完整工具集与你的模型路由，只把工作纪律写进提示词附加段。新会话默认完全访问，盾牌旋钮随时收权。',
  presets: [
    { name: '标准模式', desc: '完整工具集：浏览、操作、脚本检查、站点知识、计划与子代理', note: '全量工具' },
    { name: 'PTC 模式', desc: '多步操作优先合成为程序一次执行，减少往返', note: '程序优先' },
    { name: '极简模式', desc: '最少工具用量：能一步完成就不多步', note: '最小调用' },
    { name: '创造模式', desc: '把角色、工作方式与边界整理成可保存的自定义预设', note: '造预设' },
    { name: '网页研究员', desc: '深读网页、多源交叉验证，结论附出处', note: '多源互证' },
    { name: '页面哨兵', desc: '周期观察页面变化，只读不写，有变化才报告', note: '只读监控' },
    { name: '页面调试手', desc: '面向开发者：DOM 与控制台只读探查，定位页面问题', note: '只读探查' },
    { name: '股市通', desc: '监听财经 UP 主动态，提炼个股与市场信号，可配定时任务每日监控', note: '定时监控' },
    { name: 'bilibili助手', desc: '像真人一样操作 B 站：搜索、看视频、读评论与动态、管理收藏关注，互动只按你的明确指令来', note: '真实页面操作' },
  ],
  presetsFootnote: '在输入框下方的预设胶囊里随时切换；工具集与模型路由保持不变。',
  faqEyebrow: 'BOUNDARIES',
  faqTitle: '能做什么，也说不做什么',
  faqBody: '装之前最该问的几件事，答案都在产品里，不在宣传语里。',
  faq: [
    { q: '它会偷偷动我的其他标签页吗？', a: '每一次点击、输入和请求都出现在对话流里；「每次确认」档位下，执行前先弹审批卡。工具调用、结果和你的放行决定都写进仅追加的会话日志。' },
    { q: '密码、身份证号会被发到模型那边吗？', a: '页面快照进入模型上下文之前，手机号、身份证、邮箱、银行卡号会换成占位符；截图不做脱敏，需要核对真实号码时可在插件面板关掉「快照脱敏」。' },
    { q: '需要注册账号或自建服务器吗？', a: '不需要。扩展在你的浏览器里运行，模型密钥只存本地扩展存储，会话日志也只留在本机，随时可以导出。' },
    { q: '支持哪些浏览器？', a: 'Chrome 与 Edge（MV3），需要 134 及以上版本——侧栏用到较新的 JS 特性。Firefox 与 Safari 不在支持范围内。' },
    { q: '商店版本为什么不是最新的？', a: '商店要过审核，通常落后 Release 几个版本。想用最新构建，直接从 Releases 下载 zip 解压覆盖即可；商店版适合想自动更新的场景。' },
    { q: '它怎么控制浏览器，会接管我的鼠标键盘吗？', a: '通过浏览器调试协议（chrome.debugger）驱动页面，不做系统级自动化；页面上那个光标是画出来的视觉层，不碰你的系统指针。' },
  ],
  ctaTitle: ['把浏览器交给', '一个看得见的智能体'],
  ctaBody: '下载扩展，填入你的模型 Key，第一条指令即可开始。',
  ctaPrimary: '下载扩展',
  ctaSecondary: '快速上手',
  stage: {
    instruction: '在维基百科搜索 Google Chrome，帮我总结成三点',
    placeholder: '给 Agent 发送指令…（Enter 发送，Shift+Enter 换行）',
    toolLabel: '工具调用',
    tools: [...stageTools],
    answerLead: '已打开词条页面，三点总结：',
    answer: [
      'Google Chrome 是谷歌开发的跨平台浏览器，2008 年首发',
      '基于 Chromium 开源项目，采用多进程沙箱架构',
      '自 2012 年起占全球桌面浏览器约三分之二份额',
    ],
    statusTitle: '已打开词条页面，三点总结:',
    query: 'Google Chrome',
    caption: '示意演示：工具序列与界面来自真实产品，模型回复按脚本回放。',
    panel: {
      homeTab: '维基百科',
      homeUrl: 'zh.wikipedia.org',
      articleTab: stagePanel.articleTab,
      articleUrl: stagePanel.articleUrl,
      session: stagePanel.session,
      newTask: '新建任务',
      tabs: ['对话', '轨迹'],
      chips: [
        { icon: 'model', label: 'DeepSeek-V4-Flash' },
        { icon: 'think', label: '思考: 最高' },
        { icon: 'access', label: '完全访问' },
        { icon: 'preset', label: '标准模式' },
      ],
    },
    page: stagePage,
  },
}

/** English landing copy. */
export const en: LandingCopy = {
  accent: 'in your browser',
  accentStartsLine: true,
  heroProof: ['Open source · MIT', 'No account needed', 'Keys stay local'],
  installLabel: 'INSTALL',
  installTitle: 'Latest build first',
  installBody: 'A GitHub Release tracks the code and is always current; store builds wait on review and usually trail by a few versions.',
  installDirectLabel: 'DIRECT DOWNLOAD · RECOMMENDED',
  installDirectTitle: 'Download the latest build from Releases',
  installDirectBody: 'Unzip it, then load it as an unpacked extension; to update, download the new zip and swap the folder.',
  installDirectCta: 'Download the latest zip',
  installStoreLabel: 'STORE',
  installStoreTitle: 'Chrome Web Store / Edge Add-ons',
  installStoreBody: 'One-click install with automatic updates, at the cost of version lag while each listing sits in review.',
  installStoreCta: { chrome: 'Chrome Web Store', edge: 'Edge Add-ons' },
  steps: [
    'Download openbrowserharness.webstore.zip from Releases and unzip it.',
    'Open the extensions page at chrome://extensions (Edge: edge://extensions).',
    'Enable Developer mode, click Load unpacked, and pick the unzipped folder.',
  ],
  statsEyebrow: 'BY THE NUMBERS',
  stats: [
    { value: '60+', label: 'browser tools' },
    { value: '9', label: 'presets & modes' },
    { value: '3', label: 'permission tiers' },
    { value: '100%', label: 'local session log' },
  ],
  controlEyebrow: 'IN YOUR HANDS',
  controlTitle: 'It acts. You decide.',
  controlBody: 'A browser is the most honest interface you can watch: every step lands on a real page, every action waits for your go-ahead, and the run replays on a timeline afterwards.',
  controlCards: [
    { key: 'approval', title: 'Approval per action', body: 'A click, a keystroke, or a request first becomes a card: allow once, allow for this session, or refuse.' },
    { key: 'tiers', title: 'Three access tiers', body: 'Confirm every time, confirm changes only, or full access — the shield in the side panel moves either way, so read-only runs stay unattended.' },
    { key: 'log', title: 'Append-only log', body: 'Every byte the model sees lands in the session log: system prompts, tool results, approval decisions — exportable whenever you want to check.' },
  ],
  controlMock: {
    approval: { tool: 'page_click', ask: 'Click “Search” on this page?', allow: 'Allow', deny: 'Deny' },
    tiers: { label: 'Access', items: ['Confirm each', 'Changes only', 'Full access'], active: 1 },
    log: {
      label: 'Session log',
      lines: ['tool result · page_snapshot', 'approval · page_click allowed', 'answer · three points'],
      export: 'Export .jsonl',
    },
  },
  journeyEyebrow: 'HOW IT RUNS',
  journeyTitle: 'One instruction, three stages',
  journeyBody: 'From a sentence in plain language, to a click you can watch, to a log you can replay — each stage has the capability behind it.',
  journey: [
    {
      key: '01',
      title: 'You state the goal',
      body: 'Research, forms, a page you want watched — one sentence is enough, and you pick the model and the extensions.',
      caps: [
        { icon: 'model', title: 'Your model', body: 'DeepSeek, Zhipu GLM, any OpenAI-compatible or Anthropic-protocol endpoint, or local Ollama — keys stay local.' },
        { icon: 'code', title: 'Extensible base', body: 'User plugins in a hot-loaded sandbox, captured skills, and slash commands; the model can write plugins for you.' },
      ],
    },
    {
      key: '02',
      title: 'It drives real pages',
      body: 'Humanized input and a visible cursor land on real tabs: multi-tab management, Shadow-DOM piercing, per-keystroke typing.',
      caps: [
        { icon: 'cursor', title: 'Real page operations', body: 'Bézier paths, per-keystroke typing, inertial scrolling — driven through the debugging protocol, never OS automation.' },
        { icon: 'learn', title: 'Site learning · /learn-site', body: 'Learns a site’s same-origin pages into a cheat sheet, injected automatically when you return to that site.' },
        { icon: 'video', title: 'Video intelligence', body: 'Subtitle-first Q&A on video pages, answered at a timestamp and carrying EVID evidence references.' },
      ],
    },
    {
      key: '03',
      title: 'Everything is traceable',
      body: 'Every byte the model sees stays on this machine, and the whole turn replays on a timeline afterwards.',
      caps: [
        { icon: 'redact', title: 'Redacted before the model', body: 'Phone numbers, ID numbers, emails, and card numbers become placeholders before a snapshot reaches the context.' },
        { icon: 'log', title: 'Append-only log', body: 'System prompts, tool results, and approval decisions land on disk one by one; logs replay and export.' },
      ],
    },
  ],
  designEyebrow: 'DESIGN NOTES',
  designTitle: 'Visible actions, durable memory',
  rows: [
    {
      eyebrow: 'OPERATE',
      title: 'Watch it work',
      body: 'The virtual cursor follows Bézier paths, types per keystroke, and scrolls with inertia. Pages are driven through the browser debugging protocol — never OS-level automation — so every click happens on the real page, visible and interruptible.',
      shot: 'chat',
      alt: 'One turn in the side panel: the instruction, tabs_open and page_extract_text tool calls, then a three-point answer',
      caption: 'Chat · tool calls and a three-point answer',
      frame: '1120 / 1400',
    },
    {
      eyebrow: 'REVIEW',
      title: 'Every run is traceable',
      body: 'Everything the model sees is recorded in an append-only session log: system prompts, tool calls and results, approval decisions, and every context injection. The trajectory view replays a turn as timeline cards, with input, model, and tool swimlanes showing where the time went — and logs export for review.',
      shot: 'trajectory',
      alt: 'The trajectory view: input, model, and tool swimlanes above, timeline cards for the user message, two tool calls, and the assistant reply below',
      caption: 'Trajectory · timeline replay',
      frame: '1120 / 1400',
    },
    {
      eyebrow: 'SANITIZE',
      title: 'Redacted before the model reads it',
      body: 'Before a snapshot reaches the model context, phone numbers, ID numbers, emails, and card numbers become placeholders; screenshots stay unredacted, so switch it off when you need the real digits. A learned site (/learn-site) turns into a cheat sheet injected only on matching tabs — and every switch toggles on its own.',
      shot: 'plugins',
      alt: 'Built-in capability switches in the user-plugin panel: site cheat-sheet injection, snapshot redaction, virtual pointer, humanized input, snapshot slimming',
      caption: 'Built-in capabilities · one switch each',
      frame: '1120 / 976',
    },
  ],
  presetsEyebrow: 'PRESETS',
  presetsTitle: 'Nine presets, four working styles',
  presetsBody: 'Every preset keeps the full tool set and your model route, encoding only its working discipline as a prompt addendum. New sessions start full-access; the shield knob tightens it anytime.',
  presets: [
    { name: 'Standard', desc: 'Full tool set: browsing, actions, script checks, site knowledge, plans, subagents', note: 'full tools' },
    { name: 'PTC', desc: 'Synthesizes multi-step operations into one program run to cut round trips', note: 'program first' },
    { name: 'Minimal', desc: 'Fewest tool calls — one step when one step suffices', note: 'minimal calls' },
    { name: 'Create', desc: 'Turns a role, working style, and boundaries into a saveable custom preset', note: 'make presets' },
    { name: 'Web researcher', desc: 'Deep reads, multi-source cross-checks, cited conclusions', note: 'multi-source' },
    { name: 'Page sentinel', desc: 'Watches pages on a cadence, read-only, reports only on change', note: 'read-only watch' },
    { name: 'Dev probe', desc: 'For developers: read-only DOM and console probing to pin down page issues', note: 'read-only probe' },
    { name: 'Market watcher', desc: 'Follows finance creators, distills stock and market signals, daily schedule optional', note: 'scheduled watch' },
    { name: 'Bilibili assistant', desc: 'Works bilibili.com like a person: search, watch, read comments and updates, manage favorites and follows; interacts only on your explicit instruction', note: 'page operations' },
  ],
  presetsFootnote: 'Switch from the preset chip under the composer; the tool set and model route stay as they are.',
  faqEyebrow: 'BOUNDARIES',
  faqTitle: 'What it does, and what it will not',
  faqBody: 'The questions worth asking before installing, answered by the product rather than the pitch.',
  faq: [
    { q: 'Will it touch my other tabs behind my back?', a: 'Every click, keystroke, and request shows up in the conversation; in the confirm-every-time tier an approval card comes first. Tool calls, results, and your decisions go into the append-only session log.' },
    { q: 'Do passwords and ID numbers reach the model?', a: 'Before a snapshot enters the model context, phone numbers, ID numbers, emails, and card numbers become placeholders. Screenshots are not redacted, and you can switch snapshot redaction off in the plugin panel when you need the real digits.' },
    { q: 'Do I need an account or my own server?', a: 'No. The extension runs in your browser, model keys stay in local extension storage, and session logs stay on this machine — exportable whenever you want.' },
    { q: 'Which browsers are supported?', a: 'Chrome and Edge (MV3), version 134 or newer — the side panel relies on recent JavaScript features. Firefox and Safari are out of scope.' },
    { q: 'Why is the store version not the latest?', a: 'Store listings wait on review and usually trail the Release by a few versions. For the newest build, download the zip from Releases and swap the folder; the store build is for automatic updates.' },
    { q: 'How does it drive the browser — does it take over my mouse and keyboard?', a: 'Pages are driven through the browser debugging protocol (chrome.debugger), never OS-level automation. The cursor you see is a visual layer drawn on the page; your system pointer is untouched.' },
  ],
  ctaTitle: ['Hand your browser to', 'an agent you can watch'],
  ctaBody: 'Download the extension, add your model key, and start with your first instruction.',
  ctaPrimary: 'Download',
  ctaSecondary: 'Quick start',
  stage: {
    instruction: 'Search Wikipedia for Google Chrome and summarize it in three points',
    placeholder: 'Message the agent… (Enter to send, Shift+Enter for a new line)',
    toolLabel: 'Tool call',
    tools: [...stageTools],
    answerLead: 'Opened the article. Three points:',
    answer: [
      'Google Chrome is a cross-platform browser developed by Google, first released in 2008',
      'Built on the open-source Chromium project, with a multi-process sandbox architecture',
      'Has held about two thirds of the global desktop browser market since 2012',
    ],
    statusTitle: 'Opened the article, three points:',
    query: 'Google Chrome',
    caption: 'Illustrative demo: the tool sequence and interface come from the shipping product; the model reply is scripted.',
    panel: {
      homeTab: 'Wikipedia',
      homeUrl: 'en.wikipedia.org',
      articleTab: stagePanel.articleTab,
      articleUrl: stagePanel.articleUrl,
      session: stagePanel.session,
      newTask: 'New task',
      tabs: ['Chat', 'Trajectory'],
      chips: [
        { icon: 'model', label: 'DeepSeek-V4-Flash' },
        { icon: 'think', label: 'Thinking: Max' },
        { icon: 'access', label: 'Full access' },
        { icon: 'preset', label: 'Standard' },
      ],
    },
    page: stagePage,
  },
}
