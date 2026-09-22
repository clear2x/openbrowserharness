<script setup lang="ts">
/**
 * Site layout: the default theme plus the landing hero collage injected
 * through the `home-hero-image` slot. Every other page renders untouched.
 */
import { useData } from 'vitepress'
import DefaultTheme from 'vitepress/theme'

const { Layout } = DefaultTheme
const { lang } = useData()
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
          src="./assets/panel-conversation.jpg"
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
  </Layout>
</template>
