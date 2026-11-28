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
import shotChatDark from './assets/panel-chat-dark.webp'
import shotChatLight from './assets/panel-chat-light.webp'
import shotPluginsDark from './assets/panel-plugins-dark.webp'
import shotPluginsLight from './assets/panel-plugins-light.webp'
import shotTrajectoryDark from './assets/panel-trajectory-dark.webp'
import shotTrajectoryLight from './assets/panel-trajectory-light.webp'
import whaleDeep from './assets/brand/whale-figure-deep.svg'
import whaleIce from './assets/brand/whale-figure-ice.svg'

/** Monoline glyph paths on a 24-unit grid, one entry per capability icon. */
const CAP_ICONS = {
  model: ['M2 18v3c0 .6.4 1 1 1h4v-3h3v-3h2l1.4-1.4a6.5 6.5 0 1 0-4-4Z', 'M16.5 7.5h.01'],
  code: ['m8 5-5 7 5 7', 'm16 5 5 7-5 7'],
  cursor: ['M4 4l7.07 17.6 2.53-7.53L21 11.07 4 4z'],
  learn: ['M12 3a9 9 0 1 0 9 9', 'M17 3h4v4', 'M21 3 12 12'],
  video: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'm10 9 5 3-5 3z'],
  redact: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', 'M14.5 9.5a3.5 3.5 0 1 1-5 5', 'M4.5 19.5 19.5 4.5'],
  log: ['M4 12a8 8 0 1 0 2.6-5.9', 'M4 4.5V9h4.5', 'M12 8v4.5l3 1.8'],
} as const

const { Layout } = DefaultTheme
const { lang, frontmatter, isDark } = useData()

/** Design-row screenshots per appearance, keyed as `landing-copy.ts` names them. */
const SHOTS: Record<ShotKey, { light: string; dark: string }> = {
  chat: { light: shotChatLight, dark: shotChatDark },
  trajectory: { light: shotTrajectoryLight, dark: shotTrajectoryDark },
  plugins: { light: shotPluginsLight, dark: shotPluginsDark },
}

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
/** The two published store listings, the install path the README recommends. */
const storeChrome = 'https://chromewebstore.google.com/detail/bleodidoeedilojmbklkcbelamehbimj'
const storeEdge = 'https://microsoftedge.microsoft.com/addons/detail/hfhgnobjheiffkedldooeehanpamocni'
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
    <template #home-hero-actions-after>
      <!-- Facts under the buttons: what a visitor can check before installing. -->
      <ul class="hero-proof">
        <li v-for="item in copy.heroProof" :key="item">{{ item }}</li>
      </ul>
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

      <section class="control" :aria-label="copy.controlTitle">
        <header class="section-head" data-reveal>
          <p class="eyebrow">{{ copy.controlEyebrow }}</p>
          <h2 class="section-title">{{ copy.controlTitle }}</h2>
          <p class="section-body">{{ copy.controlBody }}</p>
        </header>
        <div class="control-grid">
          <article
            v-for="card in copy.controlCards"
            :key="card.key"
            class="control-card"
            data-reveal
          >
            <!-- The mocks restate the shipped UI; the caption under each carries the meaning. -->
            <div class="control-mock" aria-hidden="true">
              <template v-if="card.key === 'approval'">
                <span class="mock-tag">
                  <svg class="ic" viewBox="0 0 24 24"><path d="M12 3.5 5.5 6v5.8c0 4.1 2.7 7.1 6.5 8.5 3.8-1.4 6.5-4.4 6.5-8.5V6z" /></svg>
                  {{ copy.controlMock.approval.tool }}
                </span>
                <p class="mock-ask">{{ copy.controlMock.approval.ask }}</p>
                <div class="mock-actions">
                  <span class="mock-btn">{{ copy.controlMock.approval.deny }}</span>
                  <span class="mock-btn is-primary">{{ copy.controlMock.approval.allow }}</span>
                </div>
              </template>
              <template v-else-if="card.key === 'tiers'">
                <p class="mock-label">{{ copy.controlMock.tiers.label }}</p>
                <div class="mock-seg">
                  <span
                    v-for="(tier, j) in copy.controlMock.tiers.items"
                    :key="tier"
                    :class="{ 'is-active': j === copy.controlMock.tiers.active }"
                  >{{ tier }}</span>
                </div>
              </template>
              <template v-else>
                <p class="mock-label">
                  {{ copy.controlMock.log.label }}
                  <span class="mock-export">{{ copy.controlMock.log.export }}</span>
                </p>
                <p v-for="line in copy.controlMock.log.lines" :key="line" class="mock-log-line">{{ line }}</p>
              </template>
            </div>
            <h3 class="control-title">{{ card.title }}</h3>
            <p class="control-body">{{ card.body }}</p>
          </article>
        </div>
      </section>
    </template>

    <template #home-features-after>
      <section class="journey">
        <header class="section-head" data-reveal>
          <p class="eyebrow">{{ copy.journeyEyebrow }}</p>
          <h2 class="section-title">{{ copy.journeyTitle }}</h2>
          <p class="section-body">{{ copy.journeyBody }}</p>
        </header>
        <ol class="journey-row">
          <li v-for="stage in copy.journey" :key="stage.key" class="journey-stage" data-reveal>
            <div class="journey-head">
              <span class="journey-key">{{ stage.key }}</span>
              <h3 class="journey-title">{{ stage.title }}</h3>
            </div>
            <p class="journey-body">{{ stage.body }}</p>
            <ul class="cap-list">
              <li v-for="cap in stage.caps" :key="cap.title" class="cap">
                <svg class="cap-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path v-for="d in CAP_ICONS[cap.icon]" :key="d" :d="d" />
                </svg>
                <div>
                  <p class="cap-title">{{ cap.title }}</p>
                  <p class="cap-body">{{ cap.body }}</p>
                </div>
              </li>
            </ul>
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
          <figure class="design-shot">
            <div class="design-shot-bar">
              <span class="design-shot-dots"><i /><i /><i /></span>
              <span class="design-shot-title">{{ row.caption }}</span>
            </div>
            <div class="design-shot-screen" :style="{ aspectRatio: row.frame }">
              <img :src="SHOTS[row.shot][isDark ? 'dark' : 'light']" :alt="row.alt" loading="lazy">
            </div>
          </figure>
        </div>
      </section>

      <section class="presets">
        <header class="section-head presets-head" data-reveal>
          <p class="eyebrow">{{ copy.presetsEyebrow }}</p>
          <h2 class="section-title">{{ copy.presetsTitle }}</h2>
          <p class="section-body">{{ copy.presetsBody }}</p>
        </header>
        <div class="preset-picker" data-reveal>
          <div class="preset-rail" role="tablist" aria-orientation="vertical" :aria-label="copy.presetsTitle">
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
            >
              <span class="preset-tab-index" aria-hidden="true">{{ String(i + 1).padStart(2, '0') }}</span>
              <span class="preset-tab-name">{{ preset.name }}</span>
              <span class="preset-tab-note">{{ preset.note }}</span>
            </button>
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
            <p class="preset-detail-index">
              <span>{{ String(i + 1).padStart(2, '0') }}</span>
              <span aria-hidden="true">/</span>
              <span>{{ String(copy.presets.length).padStart(2, '0') }}</span>
            </p>
            <p class="preset-detail-note">{{ preset.note }}</p>
            <p class="preset-detail-name">{{ preset.name }}</p>
            <p class="preset-detail-desc">{{ preset.desc }}</p>
            <p class="preset-detail-foot">{{ copy.presetsFootnote }}</p>
          </div>
        </div>
      </section>

      <section class="faq">
        <header class="section-head" data-reveal>
          <p class="eyebrow">{{ copy.faqEyebrow }}</p>
          <h2 class="section-title">{{ copy.faqTitle }}</h2>
          <p class="section-body">{{ copy.faqBody }}</p>
        </header>
        <dl class="faq-list">
          <div v-for="(item, i) in copy.faq" :key="item.q" class="faq-item" data-reveal>
            <dt class="faq-q">
              <span class="faq-index" aria-hidden="true">{{ String(i + 1).padStart(2, '0') }}</span>
              {{ item.q }}
            </dt>
            <dd class="faq-a">{{ item.a }}</dd>
          </div>
        </dl>
      </section>

      <section class="install">
        <header class="install-head" data-reveal>
          <p class="eyebrow">{{ copy.installLabel }}</p>
          <h2 class="section-title">{{ copy.installTitle }}</h2>
          <p class="section-body">{{ copy.installBody }}</p>
        </header>
        <div class="install-paths">
          <article class="install-card is-store" data-reveal>
            <p class="eyebrow">{{ copy.installStoreLabel }}</p>
            <h3 class="install-card-title">{{ copy.installStoreTitle }}</h3>
            <p class="install-card-body">{{ copy.installStoreBody }}</p>
            <div class="install-actions">
              <a class="install-store" :href="storeChrome">
                <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3.4" /><path d="M12 8.6h9M9 14.7 4.5 6.9M15 14.7l-4.6 8" /></svg>
                {{ copy.installStoreCta.chrome }}
              </a>
              <a class="install-store is-alt" :href="storeEdge">
                <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 15.5c-1-2.6-.4-5.7 1.7-7.6 2.6-2.4 6.5-2.2 8.6.4 1 1.2 1.5 2.7 1.5 4.3 0 .6-.5 1-1.1.9l-7.6-1.6a2.7 2.7 0 0 0-3.1 3.6z" /><path d="M5 16.6c1.3 2.1 3.8 3.1 6.2 2.4 2.3-.7 3.9-2.8 3.9-5.2" /><path d="M14.8 8.3c2.3.6 4 2.4 4.5 4.6" /></svg>
                {{ copy.installStoreCta.edge }}
              </a>
            </div>
          </article>
          <article class="install-card" data-reveal>
            <p class="eyebrow">{{ copy.installDevLabel }}</p>
            <h3 class="install-card-title">{{ copy.installDevTitle }}</h3>
            <ol class="install-steps">
              <li v-for="(step, i) in copy.steps" :key="step" class="install-step">
                <span class="install-num" aria-hidden="true">{{ String(i + 1).padStart(2, '0') }}</span>
                <!-- The markup only wraps addresses and labels of a build-time constant. -->
                <p class="install-text" v-html="formatStep(step)" />
              </li>
            </ol>
            <a class="install-release" :href="releaseLink">{{ copy.installDevCta }}</a>
          </article>
        </div>
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
