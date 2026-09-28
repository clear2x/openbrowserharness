<script setup lang="ts">
/**
 * Site layout: the default theme plus landing-only injections — the hero
 * collage (`home-hero-image`), the provider chips under the hero actions,
 * and the three-step strip after the feature grid. Every other page renders
 * the stock layout untouched.
 */
import { useData } from 'vitepress'
import DefaultTheme from 'vitepress/theme'

const { Layout } = DefaultTheme
const { lang } = useData()

interface StepCopy {
  n: string
  t: string
  d: string
}

interface LandingCopy {
  chipsLabel: string
  chips: string[]
  heading: string
  steps: StepCopy[]
}

const zh: LandingCopy = {
  chipsLabel: '开箱接入',
  chips: ['DeepSeek', '智谱 GLM', 'OpenAI 兼容', 'Anthropic 协议', '本地 Ollama'],
  heading: '如何工作',
  steps: [
    { n: '01', t: '下达任务', d: '在侧边栏用一句话交代目标；复杂任务可以附上下文与约束。' },
    { n: '02', t: '看它操作', d: '智能体规划步骤、驱动真实页面，每一次点击与输入都可视、可中断。' },
    { n: '03', t: '你来把关', d: '敏感操作弹出审批卡等你放行，会话日志可导出复盘。' },
  ],
}

const en: LandingCopy = {
  chipsLabel: 'Works with',
  chips: ['DeepSeek', 'Zhipu GLM', 'OpenAI-compatible', 'Anthropic', 'local Ollama'],
  heading: 'How it works',
  steps: [
    { n: '01', t: 'Give a task', d: 'Describe the goal in one sentence; attach context and constraints for complex jobs.' },
    { n: '02', t: 'Watch it work', d: 'The agent plans steps and drives real pages — every click and keystroke is visible and interruptible.' },
    { n: '03', t: 'You stay in charge', d: 'Sensitive actions raise approval cards, and session logs export for review.' },
  ],
}

const copy = lang.value.startsWith('zh') ? zh : en

const frontAlt = lang.value.startsWith('zh')
  ? '真实任务执行中：agent 打开 Google Chrome 条目，调用工具并给出三点总结'
  : 'A real task in flight — the agent opens the Google Chrome article, calls a tool, and answers with a three-point summary'
</script>

<template>
  <Layout>
    <template #home-hero-image>
      <div class="landing-collage">
        <img
          class="collage-img collage-back collage-back-left"
          src="./assets/panel-welcome.jpg"
          alt=""
          aria-hidden="true"
        />
        <img
          class="collage-img collage-back collage-back-right"
          src="./assets/panel-trajectory.jpg"
          alt=""
          aria-hidden="true"
        />
        <img
          class="collage-img collage-front"
          src="./assets/panel-task.jpg"
          :alt="frontAlt"
        />
      </div>
    </template>
    <template #home-hero-actions-after>
      <p class="hero-chips">
        <span class="chips-label">{{ copy.chipsLabel }}</span>
        <span v-for="chip in copy.chips" :key="chip" class="chip">{{ chip }}</span>
      </p>
    </template>
    <template #home-features-after>
      <section class="landing-steps">
        <h2 class="steps-heading">{{ copy.heading }}</h2>
        <ol class="steps-grid">
          <li v-for="step in copy.steps" :key="step.n" class="step-card">
            <span class="step-num">{{ step.n }}</span>
            <h3 class="step-title">{{ step.t }}</h3>
            <p class="step-desc">{{ step.d }}</p>
          </li>
        </ol>
      </section>
    </template>
  </Layout>
</template>
