<script setup lang="ts">
/**
 * Site layout: the default theme plus landing-only injections — the hero
 * install panel (in the `home-hero-image` seat) and the design section after
 * the feature grid. Everything else renders the stock layout untouched.
 *
 * The visual language follows the plain-engineering school: flat near-black
 * surface, hairline borders, monospace eyebrows, screenshots shown as-is —
 * no gradients, glows, or floating decoration.
 */
import { onMounted } from 'vue'
import { useData } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
// Static imports: a dynamic `:src` string would not be resolved by the build.
import shotTask from './assets/panel-task.jpg'
import shotTrajectory from './assets/panel-trajectory.jpg'

const { Layout } = DefaultTheme
const { lang } = useData()

interface DesignRow {
  eyebrow: string
  title: string
  body: string
  shot: string
  alt: string
}

interface LandingCopy {
  installLabel: string
  steps: string[]
  designEyebrow: string
  designTitle: string
  rows: DesignRow[]
}

const zh: LandingCopy = {
  installLabel: '安装 · INSTALL',
  steps: [
    '从 Releases 下载 openbrowserharness.webstore.zip 并解压。',
    '打开扩展管理页 chrome://extensions（Edge 为 edge://extensions）。',
    '开启「开发者模式」，点击「加载已解压的扩展程序」，选择解压后的文件夹。',
  ],
  designEyebrow: 'DESIGN NOTES',
  designTitle: '看得见的操作，留得下的记录',
  rows: [
    {
      eyebrow: 'OPERATE',
      title: '看它如何操作',
      body: '虚拟光标沿贝塞尔路径移动、逐键输入、惯性滚动。页面由浏览器调试协议直接驱动，不碰系统级自动化——每一次点击都发生在真实页面上，可见，也可随时中断。',
      shot: shotTask,
      alt: '智能体在侧边栏中调用 tabs_open 打开维基百科词条，并以三点总结作答',
    },
    {
      eyebrow: 'REVIEW',
      title: '每一步有迹可循',
      body: '模型看到的一切都写入仅追加的会话日志：系统提示词、工具调用与结果、审批放行、每一次上下文注入。轨迹视图按来源回放整个回合，日志可导出留存。',
      shot: shotTrajectory,
      alt: '轨迹视图按用户、工具、工具结果、助手逐行回放一个回合',
    },
  ],
}

const en: LandingCopy = {
  installLabel: 'INSTALL',
  steps: [
    'Download openbrowserharness.webstore.zip from Releases and unzip it.',
    'Open the extensions page at chrome://extensions (Edge: edge://extensions).',
    'Enable Developer mode, click Load unpacked, and pick the unzipped folder.',
  ],
  designEyebrow: 'DESIGN NOTES',
  designTitle: 'Visible actions, durable records',
  rows: [
    {
      eyebrow: 'OPERATE',
      title: 'Watch it work',
      body: 'The virtual cursor follows Bézier paths, types per keystroke, and scrolls with inertia. Pages are driven through the browser debugging protocol — never OS-level automation — so every click happens on the real page, visible and interruptible.',
      shot: shotTask,
      alt: 'The agent calls tabs_open on a Wikipedia article in the side panel and answers with a three-point summary',
    },
    {
      eyebrow: 'REVIEW',
      title: 'Every run is traceable',
      body: 'Everything the model sees is recorded in an append-only session log: system prompts, tool calls and results, approval decisions, and every context injection. The trajectory view replays a turn by source, and logs export for review.',
      shot: shotTrajectory,
      alt: 'The trajectory view replays a turn line by line: user, tool, tool result, assistant',
    },
  ],
}

const copy = lang.value.startsWith('zh') ? zh : en

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
    </template>
  </Layout>
</template>
