<script setup lang="ts">
/**
 * Site layout: the default theme plus the landing-only surface — the hero
 * copy and the scripted stage above the feature grid, and the long-form
 * sections after it (stats strip, how-it-runs, design notes, preset picker,
 * install, closing call to action). Everything else renders the stock layout
 * untouched. The hero headline, tagline, actions, and feature cards come from
 * the `layout: home` frontmatter; the remaining landing copy is
 * `landing-copy.ts`.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useData, withBase } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import HeroStage from './HeroStage.vue'
import { en, zh, type ShotKey } from './landing-copy.ts'
import shotLearn from './assets/panel-learn.jpg'
import shotPresets from './assets/panel-presets.jpg'
import shotTask from './assets/panel-task.jpg'
import shotTrajectory from './assets/panel-trajectory.jpg'
import whaleDeep from './assets/brand/whale-figure-deep.svg'
import whaleIce from './assets/brand/whale-figure-ice.svg'

const { Layout } = DefaultTheme
const { lang, frontmatter, isDark } = useData()

/** Design-row screenshots, keyed as `landing-copy.ts` names them. */
const SHOTS: Record<ShotKey, string> = { task: shotTask, learn: shotLearn, trajectory: shotTrajectory }

/** Reads one string field of the page's `hero` frontmatter; empty when absent. */
function heroField(key: string): string {
  const hero: unknown = Reflect.get(frontmatter.value, 'hero')
  if (typeof hero !== 'object' || hero === null) return ''
  const value = Reflect.get(hero, key)
  return typeof value === 'string' ? value : ''
}

/** Marks addresses, file names, and quoted interface labels of an install step. */
function formatStep(step: string): string {
  return step
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/((?:chrome|edge):\/\/[^\s（）()]+|[\w.-]+\.zip|「[^」]+」)/g, '<code>$1</code>')
}

const copy = lang.value.startsWith('zh') ? zh : en
const guideLink = lang.value.startsWith('zh') ? '/guide/quickstart' : '/en/guide/quickstart'
const releaseLink = 'https://github.com/clear2x/openbrowserharness/releases/latest'
// Root-absolute on purpose: a bare name is resolved against the current route
// in the browser, which misses under the English locale.
const brandMark = withBase('/favicon.svg')

/** The headline with its gradient tail split off. */
const title = computed(() => {
  const text = heroField('text')
  return text.endsWith(copy.accent)
    ? { head: text.slice(0, -copy.accent.length).trimEnd(), tail: copy.accent }
    : { head: text, tail: '' }
})

// Preset picker: the tabs follow the tabs pattern, so arrow keys move the
// selection and focus together.
const activePreset = ref(0)

function selectPreset(index: number, focus: boolean): void {
  activePreset.value = index
  if (focus) document.getElementById(`preset-tab-${String(index)}`)?.focus()
}

function onPresetKey(event: KeyboardEvent, index: number): void {
  const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown'
  const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
  if (!forward && !backward) return
  event.preventDefault()
  selectPreset((index + (forward ? 1 : -1) + copy.presets.length) % copy.presets.length, true)
}

// Reveal on scroll is progressive enhancement: the head script in `config.ts`
// marks the document as script-enabled before first paint, and only then does
// the hidden start state apply, so the page is complete without JavaScript.
// One IntersectionObserver over the sections below the fold adds `is-in` to
// each `[data-reveal]` element that enters; reduced motion opts out in CSS.
// An anchor jump can leapfrog a section without it ever intersecting, so on
// mount every element already inside the viewport shows at once, and the
// observer also reveals entries that crossed above between checks.
let revealObserver: IntersectionObserver | undefined

onMounted(() => {
  const targets = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'))
  if (!('IntersectionObserver' in window)) {
    targets.forEach((el) => el.classList.add('is-in'))
    return
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting || entry.boundingClientRect.top < 0) {
        entry.target.classList.add('is-in')
        io.unobserve(entry.target)
      }
    }
  }, { threshold: 0.12, rootMargin: '0px 0px 8% 0px' })
  revealObserver = io
  for (const el of targets) {
    if (el.getBoundingClientRect().top < window.innerHeight) el.classList.add('is-in', 'is-instant')
    else io.observe(el)
  }
  requestAnimationFrame(() => {
    for (const el of targets) el.classList.remove('is-instant')
  })
})

// An observer left connected keeps its removed targets alive across client-side navigation.
onBeforeUnmount(() => { revealObserver?.disconnect() })
</script>

<template>
  <Layout>
    <template #home-hero-info>
      <div class="hero-copy">
        <!-- The mark alone: the nav already carries the product name. -->
        <p class="hero-kicker">
          <img class="hero-mark" :src="brandMark" alt="" width="34" height="34">
        </p>
        <!-- The separating space sits inside the first phrase: between the spans it is dropped in server rendering. -->
        <h1 class="hero-title" :class="copy.accentStartsLine ? 'is-stacked' : 'is-lockup'">
          <span class="hero-title-head">{{ title.head }}{{ copy.accentStartsLine ? ' ' : '' }}</span>
          <span v-if="title.tail" class="hero-accent">{{ title.tail }}</span>
        </h1>
        <p class="hero-tagline">{{ heroField('tagline') }}</p>
      </div>
    </template>
    <template #home-hero-image>
      <HeroStage :copy="copy.stage" />
    </template>

    <template #home-hero-after>
      <section class="stats" :aria-label="copy.statsEyebrow">
        <p class="eyebrow stats-eyebrow">{{ copy.statsEyebrow }}</p>
        <dl class="stats-row" data-reveal>
          <div v-for="stat in copy.stats" :key="stat.label" class="stat">
            <dt class="stat-label">{{ stat.label }}</dt>
            <dd class="stat-value">{{ stat.value }}</dd>
          </div>
        </dl>
      </section>
    </template>

    <template #home-features-after>
      <section class="flow">
        <header class="section-head" data-reveal>
          <p class="eyebrow">{{ copy.flowEyebrow }}</p>
          <h2 class="section-title">{{ copy.flowTitle }}</h2>
        </header>
        <ol class="flow-row">
          <li
            v-for="(step, i) in copy.flow"
            :key="step.key"
            class="flow-step"
            :style="{ '--step': i }"
            data-reveal
          >
            <span class="flow-key">{{ step.key }}</span>
            <span v-if="i < copy.flow.length - 1" class="flow-track" aria-hidden="true" />
            <h3 class="flow-title">{{ step.title }}</h3>
            <p class="flow-body">{{ step.body }}</p>
          </li>
        </ol>
      </section>

      <section class="design">
        <header class="section-head" data-reveal>
          <p class="eyebrow">{{ copy.designEyebrow }}</p>
          <h2 class="section-title">{{ copy.designTitle }}</h2>
        </header>
        <div v-for="row in copy.rows" :key="row.eyebrow" class="design-row" data-reveal>
          <div class="design-copy">
            <p class="eyebrow">{{ row.eyebrow }}</p>
            <h3 class="design-row-title">{{ row.title }}</h3>
            <p class="design-body">{{ row.body }}</p>
          </div>
          <figure class="design-shot" :style="{ aspectRatio: row.frame }">
            <img :src="SHOTS[row.shot]" :alt="row.alt" loading="lazy">
          </figure>
        </div>
      </section>

      <section class="presets">
        <header class="section-head presets-head" data-reveal>
          <div>
            <p class="eyebrow">{{ copy.presetsEyebrow }}</p>
            <h2 class="section-title">{{ copy.presetsTitle }}</h2>
            <p class="section-body">{{ copy.presetsBody }}</p>
          </div>
          <figure class="preset-shot">
            <img :src="shotPresets" :alt="copy.presetsAlt" loading="lazy">
          </figure>
        </header>
        <div class="preset-picker" data-reveal>
          <div class="preset-tabs" role="tablist" :aria-label="copy.presetsTitle">
            <button
              v-for="(preset, i) in copy.presets"
              :id="`preset-tab-${String(i)}`"
              :key="preset.name"
              type="button"
              role="tab"
              class="preset-tab"
              :class="{ 'is-active': i === activePreset, 'is-boundary': i === 3 }"
              :aria-selected="i === activePreset"
              :aria-controls="`preset-panel-${String(i)}`"
              :tabindex="i === activePreset ? 0 : -1"
              @click="selectPreset(i, false)"
              @keydown="onPresetKey($event, i)"
            >{{ preset.name }}</button>
          </div>
          <div
            v-for="(preset, i) in copy.presets"
            :id="`preset-panel-${String(i)}`"
            :key="preset.name"
            role="tabpanel"
            class="preset-detail"
            :aria-labelledby="`preset-tab-${String(i)}`"
            :hidden="i !== activePreset"
          >
            <p class="preset-detail-name">{{ preset.name }}</p>
            <p class="preset-detail-note">{{ preset.note }}</p>
            <p class="preset-detail-desc">{{ preset.desc }}</p>
          </div>
        </div>
      </section>

      <section class="install" data-reveal>
        <p class="eyebrow">{{ copy.installLabel }}</p>
        <ol class="install-steps">
          <li v-for="(step, i) in copy.steps" :key="step" class="install-step">
            <span class="install-num" aria-hidden="true">{{ String(i + 1).padStart(2, '0') }}</span>
            <!-- The markup only wraps addresses and labels of a build-time constant. -->
            <p class="install-text" v-html="formatStep(step)" />
          </li>
        </ol>
      </section>

      <section class="cta">
        <div class="cta-tile" data-reveal>
          <div class="cta-copy">
            <!-- Single line on purpose: the space between the phrases is emitted only for locales that need one. -->
            <h2 class="cta-title"><span class="cta-title-part">{{ copy.ctaTitle[0] }}</span>{{ copy.accentStartsLine ? ' ' : '' }}<span class="cta-title-part">{{ copy.ctaTitle[1] }}</span></h2>
            <p class="cta-body">{{ copy.ctaBody }}</p>
            <div class="cta-actions">
              <a class="cta-btn is-primary" :href="releaseLink">{{ copy.ctaPrimary }}</a>
              <a class="cta-btn" :href="guideLink">{{ copy.ctaSecondary }}</a>
            </div>
          </div>
          <img class="cta-whale" :src="isDark ? whaleIce : whaleDeep" alt="" width="128" height="128" aria-hidden="true">
        </div>
      </section>
    </template>
  </Layout>
</template>
