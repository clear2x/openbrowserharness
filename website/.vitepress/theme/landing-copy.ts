/**
 * Landing-page copy, one record per locale. The layout renders it; the
 * canonical hero and feature copy stays in the `layout: home` frontmatter.
 */

/** Design-row screenshots, keyed by name; `LandingLayout.vue` binds the files. */
export type ShotKey = 'task' | 'learn' | 'trajectory'

/** One figure in the stats strip. */
export interface Stat {
  value: string
  label: string
}

/** One step of the how-it-runs flow. */
export interface FlowStep {
  key: string
  title: string
  body: string
}

/** One screenshot-and-copy row of the design notes. */
export interface DesignRow {
  eyebrow: string
  title: string
  body: string
  shot: ShotKey
  alt: string
  /** CSS `aspect-ratio` of the visible crop; the screenshot aligns to its top edge. */
  frame: string
}

/** One shipped agent preset. */
export interface Preset {
  name: string
  desc: string
  note: string
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
  installLabel: string
  steps: string[]
  statsEyebrow: string
  stats: Stat[]
  flowEyebrow: string
  flowTitle: string
  flow: FlowStep[]
  designEyebrow: string
  designTitle: string
  rows: DesignRow[]
  presetsEyebrow: string
  presetsTitle: string
  presetsBody: string
  presets: Preset[]
  presetsAlt: string
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
  installLabel: '安装 · INSTALL',
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
  flowEyebrow: 'HOW IT RUNS',
  flowTitle: '一条指令，三段旅程',
  flow: [
    { key: '01', title: '你说目标', body: '自然语言下达任务：查资料、填表单、盯页面变化。斜杠指令、@ 子代理与技能沉淀随手可用。' },
    { key: '02', title: '它开真页面', body: '拟人化输入与可见光标在真实标签页上操作，多标签管理、Shadow DOM 穿透、逐键输入——每一步可审批、可中断。' },
    { key: '03', title: '全程有迹', body: '模型看到的一切写入仅追加会话日志；轨迹视图按时间轴回放整个回合，日志可导出复核。' },
  ],
  designEyebrow: 'DESIGN NOTES',
  designTitle: '看得见的操作，留得下的记忆',
  rows: [
    {
      eyebrow: 'OPERATE',
      title: '看它如何操作',
      body: '虚拟光标沿贝塞尔路径移动、逐键输入、惯性滚动。页面由浏览器调试协议直接驱动，不碰系统级自动化——每一次点击都发生在真实页面上，可见，也可随时中断。',
      shot: 'task',
      alt: '智能体在侧边栏中调用 tabs_open 打开维基百科词条，并以三点总结作答',
      frame: '1260 / 700',
    },
    {
      eyebrow: 'LEARN',
      title: '学过的站点，一步到位',
      body: '一条 /learn-site 指令机械学习整个站点的同源子页面，把路径、表单与稳定选择器凝练成站点速查插件。当你回到这个站点，速查自动进入模型上下文——它直接用已知选择器操作，不再反复快照探索，又快又省。',
      shot: 'learn',
      alt: '用户插件面板中的站点知识记录：学习完成后可一键启停注入',
      frame: '1260 / 1320',
    },
    {
      eyebrow: 'REVIEW',
      title: '每一步有迹可循',
      body: '模型看到的一切都写入仅追加的会话日志：系统提示词、工具调用与结果、审批放行、每一次上下文注入。轨迹视图以时间轴卡片回放整个回合——输入、模型与工具三条泳道让时间花在哪一目了然，日志可导出留存。',
      shot: 'trajectory',
      alt: '轨迹视图的时间轴卡片：用户、工具调用与结果、助手逐卡回放，顶部泳道条呈现时间分布',
      frame: '1260 / 1120',
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
  presetsAlt: '预设切换器展开后的九个预设：标准、PTC、极简、创造四种模式，加网页研究员、页面哨兵、页面调试手、股市通、bilibili助手',
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
    caption: '示意演示：指令逐键发出，可见光标在真实页面上点击、输入，每次工具调用同步出现在侧边栏。',
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
  installLabel: 'INSTALL',
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
  flowEyebrow: 'HOW IT RUNS',
  flowTitle: 'One instruction, three journeys',
  flow: [
    { key: '01', title: 'You state the goal', body: 'Tasks arrive in plain language: research, fill forms, watch a page. Slash commands, @ subagents, and skill capture are one keystroke away.' },
    { key: '02', title: 'It drives real pages', body: 'Humanized input and a visible cursor operate real tabs — multi-tab management, Shadow-DOM piercing, per-keystroke typing — every step approvable and interruptible.' },
    { key: '03', title: 'Everything is traceable', body: 'All model-visible input lands in an append-only session log; the trajectory view replays the turn on a timeline, and logs export for review.' },
  ],
  designEyebrow: 'DESIGN NOTES',
  designTitle: 'Visible actions, durable memory',
  rows: [
    {
      eyebrow: 'OPERATE',
      title: 'Watch it work',
      body: 'The virtual cursor follows Bézier paths, types per keystroke, and scrolls with inertia. Pages are driven through the browser debugging protocol — never OS-level automation — so every click happens on the real page, visible and interruptible.',
      shot: 'task',
      alt: 'The agent calls tabs_open on a Wikipedia article in the side panel and answers with a three-point summary',
      frame: '1260 / 700',
    },
    {
      eyebrow: 'LEARN',
      title: 'Learned sites, one step to act',
      body: 'A single /learn-site command mechanically learns a site and its same-origin pages and condenses paths, forms, and stable selectors into a site-knowledge plugin. Return to that site and the cheat sheet enters the model context automatically — it operates by known selectors instead of rediscovering the page, faster and cheaper.',
      shot: 'learn',
      alt: 'The site-knowledge record in the user-plugin roster, toggleable after learning',
      frame: '1260 / 1320',
    },
    {
      eyebrow: 'REVIEW',
      title: 'Every run is traceable',
      body: 'Everything the model sees is recorded in an append-only session log: system prompts, tool calls and results, approval decisions, and every context injection. The trajectory view replays a turn as timeline cards, with input, model, and tool swimlanes showing where the time went — and logs export for review.',
      shot: 'trajectory',
      alt: 'The trajectory timeline cards replay user, tool call and result, and assistant steps, with swimlane timing strips above',
      frame: '1260 / 1120',
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
  presetsAlt: 'The preset switcher open with nine presets: the Standard, PTC, Minimal and Create modes, plus web researcher, page sentinel, dev probe, market watcher and the Bilibili assistant',
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
    caption: 'Illustrative demo: the instruction is typed, a visible cursor clicks and types on the real page, and every tool call lands in the side panel.',
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
