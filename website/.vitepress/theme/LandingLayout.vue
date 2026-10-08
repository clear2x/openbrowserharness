<script setup lang="ts">
/**
 * Site layout: the default theme plus the landing-only surface — the
 * generative orbit artwork behind the hero, the install panel (in the
 * `home-hero-image` seat), and the long-form landing sections after the
 * feature grid (stats band, how-it-runs, design notes, preset gallery,
 * closing call to action). Everything else renders the stock layout
 * untouched.
 *
 * The visual language keeps the plain-engineering base (flat near-black,
 * hairline borders, monospace eyebrows, screenshots as-is) and adds one
 * generative layer: the brand's orbit-and-pointer mark, drawn live in
 * `OrbitArt.vue` behind the hero.
 */
import { onMounted } from 'vue'
import { useData } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import OrbitArt from './OrbitArt.vue'
// Static imports: a dynamic `:src` string would not be resolved by the build.
import shotTask from './assets/panel-task.jpg'
import shotTrajectory from './assets/panel-trajectory.jpg'
import shotLearn from './assets/panel-learn.jpg'
import shotPresets from './assets/panel-presets.jpg'

const { Layout } = DefaultTheme
const { lang } = useData()

interface DesignRow {
  eyebrow: string
  title: string
  body: string
  shot: string
  alt: string
}

interface FlowStep {
  key: string
  title: string
  body: string
}

interface Preset {
  name: string
  desc: string
  note: string
}

interface Stat {
  value: string
  label: string
}

interface LandingCopy {
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
  ctaTitle: string
  ctaBody: string
  ctaPrimary: string
  ctaSecondary: string
}

const zh: LandingCopy = {
  installLabel: '安装 · INSTALL',
  steps: [
    '从 Releases 下载 openbrowserharness.webstore.zip 并解压。',
    '打开扩展管理页 chrome://extensions（Edge 为 edge://extensions）。',
    '开启「开发者模式」，点击「加载已解压的扩展程序」，选择解压后的文件夹。',
  ],
  statsEyebrow: 'BY THE NUMBERS',
  stats: [
    { value: '25+', label: '浏览器工具' },
    { value: '6', label: '场景预设' },
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
      shot: shotTask,
      alt: '智能体在侧边栏中调用 tabs_open 打开维基百科词条，并以三点总结作答',
    },
    {
      eyebrow: 'LEARN',
      title: '学过的站点，一步到位',
      body: '一条 /learn-site 指令机械学习整个站点的同源子页面，把路径、表单与稳定选择器凝练成站点速查插件。当你回到这个站点，速查自动进入模型上下文——它直接用已知选择器操作，不再反复快照探索，又快又省。',
      shot: shotLearn,
      alt: '用户插件面板中的站点知识记录：学习完成后可一键启停注入',
    },
    {
      eyebrow: 'REVIEW',
      title: '每一步有迹可循',
      body: '模型看到的一切都写入仅追加的会话日志：系统提示词、工具调用与结果、审批放行、每一次上下文注入。轨迹视图以时间轴卡片回放整个回合——输入、模型与工具三条泳道让时间花在哪一目了然，日志可导出留存。',
      shot: shotTrajectory,
      alt: '轨迹视图的时间轴卡片：用户、工具调用与结果、助手逐卡回放，顶部泳道条呈现时间分布',
    },
  ],
  presetsEyebrow: 'PRESETS',
  presetsTitle: '六个开箱场景',
  presetsBody: '每个预设保留完整工具集与你的模型路由，只把工作纪律写进提示词附加段。新会话默认完全访问，盾牌旋钮随时收权。',
  presets: [
    { name: '网页研究', desc: '检索、交叉验证、汇总成文', note: '多源互证' },
    { name: '购物比价', desc: '跨店对比、历史价格、下单前确认', note: '不可逆先问' },
    { name: '视频号操作', desc: '登录态下的浏览、互动与管理', note: '会话保持' },
    { name: '表单填写', desc: '长表单逐字段录入与自我纠错', note: '逐键输入' },
    { name: '页面监控', desc: '轮询指定页面并按条件提醒', note: '定时巡视' },
    { name: '开发者调试', desc: '结构探查、网络捕获、端点逆向', note: '只读优先' },
  ],
  presetsAlt: '六个场景预设的下拉菜单：网页研究、购物比价、视频号操作、表单填写、页面监控、开发者调试',
  ctaTitle: '把浏览器交给一个看得见的智能体',
  ctaBody: '下载扩展，填入你的模型 Key，第一条指令即可开始。',
  ctaPrimary: '下载扩展',
  ctaSecondary: '快速上手',
}

const en: LandingCopy = {
  installLabel: 'INSTALL',
  steps: [
    'Download openbrowserharness.webstore.zip from Releases and unzip it.',
    'Open the extensions page at chrome://extensions (Edge: edge://extensions).',
    'Enable Developer mode, click Load unpacked, and pick the unzipped folder.',
  ],
  statsEyebrow: 'BY THE NUMBERS',
  stats: [
    { value: '25+', label: 'browser tools' },
    { value: '6', label: 'scenario presets' },
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
      shot: shotTask,
      alt: 'The agent calls tabs_open on a Wikipedia article in the side panel and answers with a three-point summary',
    },
    {
      eyebrow: 'LEARN',
      title: 'Learned sites, one step to act',
      body: 'A single /learn-site command mechanically learns a site and its same-origin pages and condenses paths, forms, and stable selectors into a site-knowledge plugin. Return to that site and the cheat sheet enters the model context automatically — it operates by known selectors instead of rediscovering the page, faster and cheaper.',
      shot: shotLearn,
      alt: 'The site-knowledge record in the user-plugin roster, toggleable after learning',
    },
    {
      eyebrow: 'REVIEW',
      title: 'Every run is traceable',
      body: 'Everything the model sees is recorded in an append-only session log: system prompts, tool calls and results, approval decisions, and every context injection. The trajectory view replays a turn as timeline cards, with input, model, and tool swimlanes showing where the time went — and logs export for review.',
      shot: shotTrajectory,
      alt: 'The trajectory timeline cards replay user, tool call and result, and assistant steps, with swimlane timing strips above',
    },
  ],
  presetsEyebrow: 'PRESETS',
  presetsTitle: 'Six scenarios out of the box',
  presetsBody: 'Every preset keeps the full tool set and your model route, encoding only its working discipline as a prompt addendum. New sessions start full-access; the shield knob tightens it anytime.',
  presets: [
    { name: 'Web research', desc: 'Search, cross-verify, synthesize', note: 'multi-source' },
    { name: 'Deal hunting', desc: 'Compare shops, price history, confirm before checkout', note: 'ask first' },
    { name: 'Video ops', desc: 'Browse, engage, and manage under your login', note: 'session kept' },
    { name: 'Form running', desc: 'Long forms, field by field, self-correcting', note: 'per keystroke' },
    { name: 'Page monitoring', desc: 'Poll pages and alert on conditions', note: 'on a cadence' },
    { name: 'Dev probing', desc: 'Structure, network capture, endpoint reverse-engineering', note: 'read-only first' },
  ],
  presetsAlt: 'The scenario-preset dropdown: web research, deal hunting, video ops, form running, page monitoring, dev probing',
  ctaTitle: 'Hand your browser to an agent you can watch',
  ctaBody: 'Download the extension, add your model key, and start with your first instruction.',
  ctaPrimary: 'Download',
  ctaSecondary: 'Quick start',
}

const copy = lang.value.startsWith('zh') ? zh : en
const guideLink = lang.value.startsWith('zh') ? '/guide/quickstart' : '/en/guide/quickstart'
const releaseLink = 'https://github.com/clear2x/openbrowserharness/releases/latest'

// Scroll reveal: one IntersectionObserver over the sections below the fold.
// Elements opt in with `data-reveal`; the observer only adds a class, so the
// page renders complete without JavaScript and reduced-motion opts out in CSS.
// An anchor jump can leapfrog a section without it ever intersecting, so on
// mount every element already at or above the viewport is revealed directly,
// and the observer also reveals entries that crossed above between checks.
onMounted(() => {
  const targets = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'))
  if (!('IntersectionObserver' in window)) {
    targets.forEach(el => el.classList.add('is-in'))
    return
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting || entry.boundingClientRect.top < 0) {
        ;(entry.target as HTMLElement).classList.add('is-in')
        io.unobserve(entry.target)
      }
    }
  }, { threshold: 0.12, rootMargin: '0px 0px 8% 0px' })
  for (const el of targets) {
    if (el.getBoundingClientRect().top < window.innerHeight) el.classList.add('is-in')
    else io.observe(el)
  }
})
</script>

<template>
  <Layout>
    <template #home-hero-info-before>
      <OrbitArt />
    </template>
    <template #home-hero-image>
      <div class="install-panel">
        <div class="install-head">
          <span class="install-dot is-red" />
          <span class="install-dot is-yellow" />
          <span class="install-dot is-green" />
          <span class="install-label">{{ copy.installLabel }}</span>
        </div>
        <ol class="install-steps">
          <li v-for="(step, i) in copy.steps" :key="i" class="install-step">
            <span class="install-num">{{ String(i + 1).padStart(2, '0') }}</span>
            <p class="install-text">{{ step }}</p>
          </li>
        </ol>
      </div>
    </template>
    <template #home-features-after>
      <section class="stats">
        <p class="band-eyebrow" data-reveal>{{ copy.statsEyebrow }}</p>
        <div class="stats-row" data-reveal>
          <div v-for="stat in copy.stats" :key="stat.label" class="stat">
            <span class="stat-value">{{ stat.value }}</span>
            <span class="stat-label">{{ stat.label }}</span>
          </div>
        </div>
      </section>

      <section class="flow">
        <p class="band-eyebrow" data-reveal>{{ copy.flowEyebrow }}</p>
        <h2 class="band-title" data-reveal>{{ copy.flowTitle }}</h2>
        <div class="flow-row">
          <div v-for="(step, i) in copy.flow" :key="step.key" class="flow-step" data-reveal>
            <div class="flow-marker">
              <span class="flow-key">{{ step.key }}</span>
              <span v-if="i < copy.flow.length - 1" class="flow-line" aria-hidden="true" />
            </div>
            <h3 class="flow-title">{{ step.title }}</h3>
            <p class="flow-body">{{ step.body }}</p>
          </div>
        </div>
      </section>

      <section class="design">
        <header class="design-head" data-reveal>
          <p class="design-eyebrow">{{ copy.designEyebrow }}</p>
          <h2 class="design-title">{{ copy.designTitle }}</h2>
        </header>
        <div v-for="row in copy.rows" :key="row.eyebrow" class="design-row" data-reveal>
          <div class="design-copy">
            <p class="design-eyebrow">{{ row.eyebrow }}</p>
            <h3 class="design-row-title">{{ row.title }}</h3>
            <p class="design-body">{{ row.body }}</p>
          </div>
          <figure class="design-shot">
            <img :src="row.shot" :alt="row.alt" loading="lazy">
          </figure>
        </div>
      </section>

      <section class="presets">
        <p class="band-eyebrow" data-reveal>{{ copy.presetsEyebrow }}</p>
        <h2 class="band-title" data-reveal>{{ copy.presetsTitle }}</h2>
        <p class="presets-body" data-reveal>{{ copy.presetsBody }}</p>
        <figure class="presets-shot" data-reveal>
          <img :src="shotPresets" :alt="copy.presetsAlt" loading="lazy">
        </figure>
        <div class="presets-grid" data-reveal>
          <div v-for="preset in copy.presets" :key="preset.name" class="preset-card">
            <div class="preset-head">
              <span class="preset-name">{{ preset.name }}</span>
              <span class="preset-note">{{ preset.note }}</span>
            </div>
            <p class="preset-desc">{{ preset.desc }}</p>
          </div>
        </div>
      </section>

      <section class="cta" data-reveal>
        <h2 class="cta-title">{{ copy.ctaTitle }}</h2>
        <p class="cta-body">{{ copy.ctaBody }}</p>
        <div class="cta-actions">
          <a class="cta-btn is-primary" :href="releaseLink">{{ copy.ctaPrimary }}</a>
          <a class="cta-btn" :href="guideLink">{{ copy.ctaSecondary }}</a>
        </div>
      </section>
    </template>
  </Layout>
</template>
