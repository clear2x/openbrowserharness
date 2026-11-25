<script setup lang="ts">
/**
 * Hero stage: a browser window showing a web page beside the extension side
 * panel, playing one agent turn on a loop — the instruction typed into the
 * composer, a visible cursor clicking and typing on the page, one row per
 * tool call, and the reply streaming in. The turn is a scripted illustration
 * built from shipped tool names and a recorded reply; the caption says so.
 * The re-enactment is hidden from assistive technology, which reads the
 * caption instead.
 *
 * Playback starts when the stage enters the viewport and restarts from the
 * first frame whenever the stage leaves the viewport or the tab is hidden.
 * Under `prefers-reduced-motion` the stage renders its last frame; without
 * JavaScript it renders its first.
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useData } from 'vitepress'
import type { StageChip, StageCopy } from './landing-copy.ts'

const props = defineProps<{ copy: StageCopy }>()
const { isDark } = useData()

/** Lifecycle of one tool-call row: not yet shown, spinner on, checked off. */
type ToolState = 'hidden' | 'running' | 'done'

/** Which page the browser shows. */
type Phase = 'home' | 'loading' | 'article'

/** A point in stage-body coordinates, in CSS pixels. */
interface Point {
  x: number
  y: number
}

/** Trail sample: a pointer position and the time it was taken. */
interface TrailPoint extends Point {
  t: number
}

/** Monoline glyph paths on a 24-unit grid. */
const ICONS = {
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M3 12h18 M12 3c2.2 2.4 3.4 5.5 3.4 9s-1.2 6.6-3.4 9c-2.2-2.4-3.4-5.5-3.4-9S9.8 5.4 12 3z',
  close: 'M7 7l10 10M17 7 7 17',
  lock: 'M7 11h10v9H7z M9.5 11V8a2.5 2.5 0 0 1 5 0v3',
  panel: 'M4 5h16v14H4z M15 5v14',
  caret: 'M8.5 5.5v13l9.5-6.5z',
  chevronDown: 'm6.5 9.5 5.5 5.5 5.5-5.5',
  history: 'M4 12a8 8 0 1 0 2.6-5.9 M4 4.5V9h4.5 M12 8v4.5l3 1.8',
  plus: 'M12 5.5v13M5.5 12h13',
  puzzle: 'M9.5 4.5h5v3.2a1.9 1.9 0 1 0 1.6 0V4.5h1.4a1 1 0 0 1 1 1v4.3h-3.2a1.9 1.9 0 1 0 0 1.6h3.2v7.1a1 1 0 0 1-1 1h-4.3v-3.2a1.9 1.9 0 1 0-1.6 0v3.2H7a1 1 0 0 1-1-1v-4.3h3.2a1.9 1.9 0 1 0 0-1.6H6V5.5a1 1 0 0 1 1-1z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7.5V12l3 2',
  expand: 'M14.5 4H20v5.5 M9.5 20H4v-5.5 M20 4l-6.5 6.5 M4 20l6.5-6.5',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M12 2.5v3 M12 18.5v3 M2.5 12h3 M18.5 12h3 M5.3 5.3l2.1 2.1 M16.6 16.6l2.1 2.1 M5.3 18.7l2.1-2.1 M16.6 7.4l2.1-2.1',
  paperclip: 'M20.5 12.5 12.6 20.4a5 5 0 0 1-7.1-7.1l7.8-7.8a3.4 3.4 0 0 1 4.7 4.7l-7.8 7.8a1.6 1.6 0 0 1-2.3-2.3l7.1-7.1',
  bulb: 'M9.5 18h5 M10.5 21h3 M12 3a6 6 0 0 0-3.4 10.9c.6.5 1 1.2 1.2 2.1h4.4c.2-.9.6-1.6 1.2-2.1A6 6 0 0 0 12 3z',
  shield: 'M12 3.5 5.5 6v5.8c0 4.1 2.7 7.1 6.5 8.5 3.8-1.4 6.5-4.4 6.5-8.5V6z',
  spark: 'M11 5l1.4 3.6L16 10l-3.6 1.4L11 15l-1.4-3.6L6 10l3.6-1.4z M18.5 14.5l.8 1.7 1.7.8-1.7.8-.8 1.7-.8-1.7-1.7-.8 1.7-.8z',
  arrowUp: 'M12 18.5V6 M6.5 11.5 12 6l5.5 5.5',
  search: 'M11 17.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z M20 20l-4.4-4.4',
  check: 'm5.5 12.5 4.2 4.2 8.8-9.4',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
} as const

/** Stroke widths for glyphs whose default line would vanish at icon size. */
const ICON_STROKES: Partial<Record<keyof typeof ICONS, number>> = { more: 4 }

/** Leading glyph of each composer chip kind; the model chip draws a dot instead. */
const CHIP_ICONS: Record<StageChip['icon'], string> = {
  model: '',
  think: ICONS.bulb,
  access: ICONS.shield,
  preset: ICONS.spark,
}

/** Pointer-trail color as an RGB triplet, one per appearance mode. */
const LIGHT_TRAIL = '61, 100, 254'
const DARK_TRAIL = '147, 170, 255'

/** How long a pointer-trail sample stays visible, in milliseconds. */
const TRAIL_MS = 460

const copy = props.copy

const stageEl = ref<HTMLElement | null>(null)
const bodyEl = ref<HTMLElement | null>(null)
const searchEl = ref<HTMLElement | null>(null)
const cursorEl = ref<HTMLElement | null>(null)
const trailEl = ref<HTMLCanvasElement | null>(null)

const typed = ref('')
const bubbleOn = ref(false)
const tools = reactive<ToolState[]>(copy.tools.map(() => 'hidden'))
const phase = ref<Phase>('home')
const query = ref('')
const searchFocus = ref(false)
const readCount = ref(0)
const replyCount = ref(0)
const statusOn = ref(false)
const fading = ref(false)
const cursorOn = ref(false)
const rippleOn = ref(false)
const rippleAt = reactive<Point>({ x: 0, y: 0 })
const isStatic = ref(false)

const rippleStyle = computed(() => ({ left: `${String(rippleAt.x)}px`, top: `${String(rippleAt.y)}px` }))

/** True once the article is on screen; the static frame is that moment. */
const atArticle = computed(() => phase.value !== 'home' || isStatic.value)

/** Token of the run in flight; a loop stops as soon as its token is no longer current. */
let run = 0
let inView = false
let playing = false
let trailRaf = 0
let cursor: Point = { x: 0, y: 0 }
let ctx: CanvasRenderingContext2D | null = null
const trail: TrailPoint[] = []
let observer: IntersectionObserver | undefined
let resizeObserver: ResizeObserver | undefined

const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

function bezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** Steps `onStep` from 0 to 1 across `ms`, stopping early once `alive` turns false. */
function tween(ms: number, alive: () => boolean, onStep: (k: number) => void): Promise<void> {
  return new Promise((resolve) => {
    let first = 0
    const tick = (now: number): void => {
      if (!alive()) {
        resolve()
        return
      }
      if (first === 0) first = now
      const k = Math.min(1, (now - first) / ms)
      onStep(k)
      if (k < 1) requestAnimationFrame(tick)
      else resolve()
    }
    requestAnimationFrame(tick)
  })
}

/** A point inside `el`, at the given fractions of its box, in stage-body coordinates. */
function pointAt(el: Element | null, fx: number, fy: number): Point {
  const origin = bodyEl.value?.getBoundingClientRect()
  const box = el?.getBoundingClientRect()
  if (origin === undefined || box === undefined) return { x: 0, y: 0 }
  return { x: box.left - origin.left + box.width * fx, y: box.top - origin.top + box.height * fy }
}

function drawTrail(now: number): void {
  trailRaf = 0
  const canvas = trailEl.value
  if (ctx === null || canvas === null) return
  const head = trail[0]
  if (head !== undefined && now - head.t > TRAIL_MS) trail.shift()
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  const rgb = isDark.value ? DARK_TRAIL : LIGHT_TRAIL
  for (const sample of trail) {
    const k = 1 - (now - sample.t) / TRAIL_MS
    ctx.beginPath()
    ctx.arc(sample.x, sample.y, 0.6 + k * 2.6, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(${rgb}, ${String(k * k * 0.7)})`
    ctx.fill()
  }
  if (trail.length > 0) trailRaf = requestAnimationFrame(drawTrail)
}

function placeCursor(point: Point): void {
  cursor = point
  cursorEl.value?.style.setProperty('transform', `translate3d(${String(point.x)}px, ${String(point.y)}px, 0)`)
  if (!cursorOn.value) return
  trail.push({ x: point.x, y: point.y, t: performance.now() })
  if (trailRaf === 0) trailRaf = requestAnimationFrame(drawTrail)
}

/** Moves the pointer to `target` along a Bézier curve bowed to one side of the straight line. */
function glide(target: Point, ms: number, alive: () => boolean): Promise<void> {
  const from = { ...cursor }
  const dx = target.x - from.x
  const dy = target.y - from.y
  const dist = Math.hypot(dx, dy) || 1
  const bend = Math.min(120, dist * 0.32)
  const c1 = { x: from.x + dx * 0.2 - (dy / dist) * bend, y: from.y + dy * 0.25 + (dx / dist) * bend }
  const c2 = { x: from.x + dx * 0.75 - (dy / dist) * bend * 0.35, y: from.y + dy * 0.8 + (dx / dist) * bend * 0.35 }
  return tween(ms, alive, (k) => { placeCursor(bezier(from, c1, c2, target, easeInOutCubic(k))) })
}

function clearTrail(): void {
  trail.length = 0
  if (trailRaf !== 0) {
    cancelAnimationFrame(trailRaf)
    trailRaf = 0
  }
  const canvas = trailEl.value
  if (canvas !== null && ctx !== null) ctx.clearRect(0, 0, canvas.width, canvas.height)
}

function reset(): void {
  typed.value = ''
  bubbleOn.value = false
  tools.fill('hidden')
  phase.value = 'home'
  query.value = ''
  searchFocus.value = false
  readCount.value = 0
  replyCount.value = 0
  statusOn.value = false
  cursorOn.value = false
  rippleOn.value = false
  clearTrail()
}

function fitCanvas(): void {
  const body = bodyEl.value
  const canvas = trailEl.value
  if (body === null || canvas === null) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.round(body.clientWidth * dpr)
  canvas.height = Math.round(body.clientHeight * dpr)
  ctx = canvas.getContext('2d')
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
}

/** Plays one turn, then starts over while `id` stays the current run. */
async function play(id: number): Promise<void> {
  const alive = (): boolean => id === run
  const pause = async (ms: number): Promise<boolean> => {
    await wait(ms)
    return alive()
  }

  if (!(await pause(420))) return

  // The instruction goes in keystroke by keystroke; Enter files it as the user message.
  for (const char of copy.instruction) {
    typed.value += char
    if (!(await pause(46 + Math.random() * 56))) return
  }
  if (!(await pause(380))) return
  typed.value = ''
  bubbleOn.value = true
  if (!(await pause(300))) return

  // page_click: the pointer leaves the tool row for the page's search box.
  tools[0] = 'running'
  if (!(await pause(180))) return
  cursorOn.value = true
  placeCursor(pointAt(stageEl.value?.querySelector('.stage-tool') ?? null, -0.012, 0.5))
  await glide(pointAt(searchEl.value, 0.14, 0.5), 980, alive)
  if (!alive()) return
  Object.assign(rippleAt, pointAt(searchEl.value, 0.14, 0.5))
  rippleOn.value = true
  searchFocus.value = true
  tools[0] = 'done'
  if (!(await pause(260))) return

  // page_type: the query lands one character at a time.
  tools[1] = 'running'
  for (const char of copy.query) {
    query.value += char
    if (!(await pause(68 + Math.random() * 62))) return
  }
  if (!(await pause(260))) return
  tools[1] = 'done'

  // page_press_key: Enter loads the result.
  tools[2] = 'running'
  if (!(await pause(220))) return
  searchFocus.value = false
  rippleOn.value = false
  cursorOn.value = false
  clearTrail()
  phase.value = 'loading'
  if (!(await pause(620))) return
  phase.value = 'article'
  if (!(await pause(160))) return
  tools[2] = 'done'

  // page_extract_text: the lead lights up sentence by sentence.
  tools[3] = 'running'
  if (!(await pause(240))) return
  for (let i = 1; i <= copy.page.lead.length; i += 1) {
    readCount.value = i
    if (!(await pause(250))) return
  }
  tools[3] = 'done'

  if (!(await pause(340))) return
  replyCount.value = 1
  for (let i = 2; i <= copy.answer.length + 1; i += 1) {
    if (!(await pause(400))) return
    replyCount.value = i
  }
  if (!(await pause(320))) return
  statusOn.value = true

  if (!(await pause(4200))) return
  fading.value = true
  if (!(await pause(560))) return
  reset()
  fading.value = false
  void play(id)
}

function stop(): void {
  run += 1
  playing = false
  fading.value = false
  reset()
}

function start(): void {
  if (playing || isStatic.value || stageEl.value === null || bodyEl.value === null) return
  playing = true
  run += 1
  void play(run)
}

const onVisibility = (): void => {
  if (document.hidden) stop()
  else if (inView) start()
}

onMounted(() => {
  isStatic.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (isStatic.value || stageEl.value === null || bodyEl.value === null) return
  fitCanvas()
  resizeObserver = new ResizeObserver(fitCanvas)
  resizeObserver.observe(bodyEl.value)
  // Start once a slice of the stage is on screen; stop only once it has left entirely.
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.intersectionRatio >= 0.15) {
        if (!inView) {
          inView = true
          start()
        }
      } else if (!entry.isIntersecting) {
        inView = false
        stop()
      }
    }
  }, { threshold: [0, 0.15] })
  observer.observe(stageEl.value)
  document.addEventListener('visibilitychange', onVisibility)
})

onBeforeUnmount(() => {
  stop()
  observer?.disconnect()
  resizeObserver?.disconnect()
  document.removeEventListener('visibilitychange', onVisibility)
})
</script>

<template>
  <figure ref="stageEl" class="stage" :class="{ 'is-static': isStatic, 'is-fading': fading }">
    <div class="stage-window" aria-hidden="true">
      <div class="stage-chrome">
        <span class="stage-lights"><i class="is-red" /><i class="is-yellow" /><i class="is-green" /></span>
        <span class="stage-tab">
          <svg class="ic" viewBox="0 0 24 24"><path :d="ICONS.globe" /></svg>
          <span class="stage-tab-text">{{ atArticle ? copy.panel.articleTab : copy.panel.homeTab }}</span>
          <svg class="ic ic-xs" viewBox="0 0 24 24"><path :d="ICONS.close" /></svg>
        </span>
        <span class="stage-omnibox">
          <svg class="ic" viewBox="0 0 24 24"><path :d="ICONS.lock" /></svg>
          <span class="stage-url">{{ atArticle ? copy.panel.articleUrl : copy.panel.homeUrl }}</span>
        </span>
        <svg class="ic stage-chrome-end" viewBox="0 0 24 24"><path :d="ICONS.panel" /></svg>
      </div>

      <div ref="bodyEl" class="stage-body">
        <div class="stage-page">
          <div class="wiki-bar"><span class="wiki-wordmark">{{ copy.page.wordmark }}</span></div>

          <div class="wiki-home" :class="{ 'is-gone': phase !== 'home' }">
            <p class="wiki-home-title">{{ copy.page.wordmark }}</p>
            <p class="wiki-home-tagline">{{ copy.page.tagline }}</p>
            <div ref="searchEl" class="wiki-search" :class="{ 'is-focus': searchFocus || isStatic }">
              <svg class="ic" viewBox="0 0 24 24"><path :d="ICONS.search" /></svg>
              <span class="wiki-query" :data-query="copy.query">{{ query }}</span>
              <i v-if="searchFocus" class="wiki-caret" />
              <span v-if="query === '' && !isStatic" class="wiki-hint">{{ copy.page.searchPlaceholder }}</span>
            </div>
          </div>

          <div class="wiki-article" :class="{ 'is-on': phase === 'article' }">
            <p class="wiki-title">{{ copy.page.title }}</p>
            <p class="wiki-from">{{ copy.page.fromLine }}</p>
            <div class="wiki-content">
              <div class="wiki-main">
                <p class="wiki-lead">
                  <span v-for="(sentence, i) in copy.page.lead" :key="sentence" :class="{ 'is-read': i < readCount || isStatic }">{{ sentence }} </span>
                </p>
                <template v-for="section in copy.page.sections" :key="section.title">
                  <p class="wiki-h2">{{ section.title }}</p>
                  <p class="wiki-p">{{ section.body }}</p>
                </template>
              </div>
              <table class="wiki-infobox">
                <tbody>
                  <tr v-for="row in copy.page.infobox" :key="row.label">
                    <th>{{ row.label }}</th>
                    <td>{{ row.value }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div class="stage-progress" :class="{ 'is-loading': phase === 'loading' }" />
        </div>

        <div class="stage-panel">
          <div class="stage-panel-head">
            <span class="stage-session">
              <svg class="ic ic-fill" viewBox="0 0 24 24"><path :d="ICONS.caret" /></svg>
              <span class="stage-session-title">{{ atArticle ? copy.panel.articleTab : copy.panel.session }}</span>
              <svg class="ic ic-xs" viewBox="0 0 24 24"><path :d="ICONS.chevronDown" /></svg>
            </span>
            <span class="stage-history">
              <svg class="ic" viewBox="0 0 24 24"><path :d="ICONS.history" /></svg>
              <svg class="ic ic-xs" viewBox="0 0 24 24"><path :d="ICONS.chevronDown" /></svg>
            </span>
            <span class="stage-new">
              <svg class="ic" viewBox="0 0 24 24"><path :d="ICONS.plus" /></svg>{{ copy.panel.newTask }}
            </span>
            <span class="stage-tools">
              <svg class="ic" viewBox="0 0 24 24"><path :d="ICONS.puzzle" /></svg>
              <svg class="ic" viewBox="0 0 24 24"><path :d="ICONS.clock" /></svg>
              <svg class="ic" viewBox="0 0 24 24"><path :d="ICONS.expand" /></svg>
              <svg class="ic" viewBox="0 0 24 24"><path :d="ICONS.gear" /></svg>
            </span>
          </div>
          <div class="stage-tabs">
            <span class="is-active">{{ copy.panel.tabs[0] }}</span>
            <span>{{ copy.panel.tabs[1] }}</span>
          </div>

          <div class="stage-chat">
            <div class="stage-bubble step" :class="{ 'is-on': bubbleOn }">{{ copy.instruction }}</div>
            <div v-for="(tool, i) in copy.tools" :key="tool" class="stage-tool step" :class="{ 'is-on': tools[i] !== 'hidden' }">
              <span class="stage-tool-text">{{ copy.toolLabel }} · {{ tool }}</span>
              <span class="stage-tool-state">
                <i class="stage-spinner" :class="{ 'is-on': tools[i] === 'running' && !isStatic }" />
                <svg class="ic stage-check" viewBox="0 0 24 24" :class="{ 'is-on': tools[i] === 'done' || isStatic }"><path :d="ICONS.check" /></svg>
              </span>
              <svg class="ic ic-xs stage-chevron" viewBox="0 0 24 24"><path :d="ICONS.chevronDown" /></svg>
            </div>
            <div class="stage-reply step" :class="{ 'is-on': replyCount > 0 || isStatic }">
              <p class="stage-reply-lead">{{ copy.answerLead }}</p>
              <ol class="stage-reply-list">
                <li v-for="(line, i) in copy.answer" :key="line" class="step" :class="{ 'is-on': replyCount > i + 1 || isStatic }">{{ line }}</li>
              </ol>
            </div>
          </div>

          <div class="stage-status step step-fade" :class="{ 'is-on': statusOn || isStatic }">
            <span>{{ copy.statusTitle }}</span>
            <span class="stage-status-end">
              <svg class="ic" viewBox="0 0 24 24" :stroke-width="ICON_STROKES.more"><path :d="ICONS.more" /></svg>
              <svg class="ic" viewBox="0 0 24 24"><path :d="ICONS.panel" /></svg>
            </span>
          </div>

          <div class="stage-composer">
            <div class="stage-input" :class="{ 'is-placeholder': typed === '' }">
              <span v-if="typed === ''">{{ copy.placeholder }}</span>
              <span v-else>{{ typed }}<i class="stage-caret" /></span>
            </div>
            <svg class="ic stage-clip" viewBox="0 0 24 24"><path :d="ICONS.paperclip" /></svg>
            <div class="stage-chips">
              <span v-for="chip in copy.panel.chips" :key="chip.label" class="stage-chip">
                <i v-if="chip.icon === 'model'" class="stage-dot" />
                <svg v-else class="ic ic-xs" viewBox="0 0 24 24"><path :d="CHIP_ICONS[chip.icon]" /></svg>
                <span class="stage-chip-label">{{ chip.label }}</span>
                <svg class="ic ic-xs" viewBox="0 0 24 24"><path :d="ICONS.chevronDown" /></svg>
              </span>
              <span class="stage-send" :class="{ 'is-on': typed !== '' }">
                <svg class="ic" viewBox="0 0 24 24"><path :d="ICONS.arrowUp" /></svg>
              </span>
            </div>
          </div>
        </div>

        <canvas ref="trailEl" class="stage-trail" />
        <div ref="cursorEl" class="stage-cursor" :class="{ 'is-on': cursorOn }">
          <svg viewBox="0 0 20 22"><path d="M2.5 1.5v16.2l4.3-4.4 2.7 6.2 3.1-1.3-2.7-6.2h6z" /></svg>
        </div>
        <span class="stage-ripple" :class="{ 'is-on': rippleOn }" :style="rippleStyle" />
      </div>
    </div>
    <figcaption class="stage-caption">{{ copy.caption }}</figcaption>
  </figure>
</template>

<style scoped>
/*
 * The re-enactment keeps one light palette in both appearance modes, each
 * color a `--stage-*` property of this block: it stands in for a screenshot,
 * and a lit window is the focal object on the dark page.
 */
.stage {
  /* Window chrome and the side panel. */
  --stage-ink: #1f2330;
  --stage-muted: #5b6472;
  --stage-faint: #8a90a0;
  --stage-chip-ink: #3b3f4a;
  --stage-white: #ffffff;
  --stage-line: #e3e5eb;
  --stage-line-strong: #c9cdd6;
  --stage-chrome: #f3f5f9;
  --stage-soft: #eceef2;
  --stage-blue: #3b6be8;
  --stage-blue-soft: #eaf1ff;
  --stage-ok: #1f9d55;
  --stage-light-red: #ff5f57;
  --stage-light-yellow: #febc2e;
  --stage-light-green: #28c840;
  --stage-progress: linear-gradient(90deg, #3366cc, #93aaff);
  --stage-cursor-shadow: drop-shadow(0 2px 3px rgba(13, 18, 32, 0.3));
  /* The re-enacted web page. */
  --stage-wiki-ink: #202122;
  --stage-wiki-muted: #54595d;
  --stage-wiki-line: #a2a9b1;
  --stage-wiki-soft: #eaecf0;
  --stage-wiki-panel: #f8f9fa;
  --stage-wiki-link: #3366cc;
  --stage-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
  --stage-serif: 'Linux Libertine', Georgia, 'Times New Roman', 'Songti SC', serif;

  display: grid;
  gap: 14px;
  justify-items: center;
  margin: 0;
  font-family: var(--stage-sans);
  text-align: left;
  -webkit-font-smoothing: antialiased;
}

.ic {
  flex: none;
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.ic-xs {
  width: 10px;
  height: 10px;
  stroke-width: 2;
}

.ic-fill {
  fill: currentColor;
  stroke: none;
}

/* ---- Window frame ---- */

.stage-window {
  width: 100%;
  max-width: 1152px;
  overflow: hidden;
  border: 1px solid var(--stage-line);
  border-radius: 16px;
  background: var(--stage-white);
  box-shadow: var(--landing-stage-shadow);
}

.stage-chrome {
  display: grid;
  grid-template-columns: auto minmax(120px, 270px) minmax(0, 1fr) auto;
  align-items: end;
  gap: 14px;
  height: 42px;
  padding: 0 12px 0 14px;
  border-bottom: 1px solid var(--stage-line);
  background: var(--stage-chrome);
  color: var(--stage-muted);
  font-size: 12px;
  line-height: 1;
}

.stage-lights {
  display: grid;
  grid-template-columns: repeat(3, 11px);
  gap: 7px;
  align-self: center;
}

.stage-lights i {
  width: 11px;
  height: 11px;
  border-radius: 50%;
}

.stage-lights .is-red { background: var(--stage-light-red); }
.stage-lights .is-yellow { background: var(--stage-light-yellow); }
.stage-lights .is-green { background: var(--stage-light-green); }

.stage-tab {
  display: flex;
  align-items: center;
  align-self: end;
  gap: 7px;
  height: 30px;
  min-width: 0;
  padding: 0 10px;
  border-radius: 9px 9px 0 0;
  background: var(--stage-white);
  color: var(--stage-ink);
}

.stage-tab-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stage-tab .ic-xs {
  color: var(--stage-faint);
}

.stage-omnibox {
  display: flex;
  align-items: center;
  align-self: center;
  gap: 7px;
  height: 28px;
  min-width: 0;
  padding: 0 12px;
  border-radius: 999px;
  background: var(--stage-white);
  color: var(--stage-ink);
}

.stage-url {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stage-chrome-end {
  align-self: center;
  color: var(--stage-ink);
}

/* The row grows with the panel: the reply is never clipped at any width. */
.stage-body {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1.7fr) minmax(300px, 1fr);
  min-height: 552px;
}

.stage-page {
  position: relative;
  min-width: 0;
  overflow: hidden;
  border-right: 1px solid var(--stage-line);
  background: var(--stage-white);
  color: var(--stage-wiki-ink);
}

.stage-progress {
  position: absolute;
  top: 38px;
  right: 0;
  left: 0;
  height: 2px;
  background: var(--stage-progress);
  transform: scaleX(0);
  transform-origin: left center;
  opacity: 0;
}

.stage-progress.is-loading {
  animation: stage-load 0.62s ease-in-out both;
}

/* ---- The web page ---- */

.wiki-bar {
  display: flex;
  align-items: center;
  height: 38px;
  padding: 0 20px;
  border-bottom: 1px solid var(--stage-wiki-soft);
  background: var(--stage-wiki-panel);
  color: var(--stage-wiki-muted);
}

.wiki-wordmark {
  font-family: var(--stage-serif);
  font-size: 13px;
  letter-spacing: 0.14em;
  color: var(--stage-wiki-ink);
}

.wiki-home {
  display: grid;
  align-content: center;
  justify-items: center;
  gap: 12px;
  height: calc(100% - 38px);
  padding: 24px;
  transition: opacity 0.3s ease-out, visibility 0s;
}

.wiki-home.is-gone {
  visibility: hidden;
  opacity: 0;
  transition: opacity 0.22s ease-in, visibility 0s 0.22s;
}

.wiki-home-title {
  margin: 0;
  font-family: var(--stage-serif);
  font-size: 46px;
  font-weight: 400;
  line-height: 1.05;
  letter-spacing: -0.01em;
}

.wiki-home-tagline {
  margin: 0;
  font-size: 12px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--stage-wiki-muted);
}

.wiki-search {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  width: min(460px, 100%);
  height: 46px;
  margin-top: 6px;
  padding: 0 14px;
  border: 1px solid var(--stage-wiki-line);
  border-radius: 2px;
  background: var(--stage-white);
  color: var(--stage-wiki-muted);
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.wiki-search.is-focus {
  border-color: var(--stage-wiki-link);
  box-shadow: inset 0 0 0 1px var(--stage-wiki-link);
}

.wiki-query {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-family: var(--stage-serif);
  font-size: 15px;
  white-space: nowrap;
  color: var(--stage-wiki-ink);
}

.is-static .wiki-query::before {
  content: attr(data-query);
}

.wiki-hint {
  position: absolute;
  left: 38px;
  font-family: var(--stage-serif);
  font-size: 15px;
  pointer-events: none;
}

.wiki-caret,
.stage-caret {
  display: inline-block;
  width: 1px;
  background: var(--stage-wiki-link);
  animation: stage-blink 1s steps(1) infinite;
}

.wiki-caret {
  position: absolute;
  left: 38px;
  height: 18px;
}

.wiki-article {
  position: absolute;
  inset: 38px 0 0;
  padding: 16px 22px 24px 20px;
  overflow: hidden;
  visibility: hidden;
  opacity: 0;
  transition: opacity 0.35s ease-out, visibility 0s;
}

.wiki-article.is-on,
.is-static .wiki-article {
  visibility: visible;
  opacity: 1;
}

.is-static .wiki-home {
  display: none;
}

.wiki-title {
  margin: 0;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--stage-wiki-line);
  font-family: var(--stage-serif);
  font-size: 28px;
  font-weight: 400;
  line-height: 1.2;
}

.wiki-from {
  margin: 6px 0 14px;
  font-size: 12px;
  color: var(--stage-wiki-muted);
}

.wiki-content {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 176px;
  align-items: start;
  gap: 18px;
}

.wiki-lead {
  margin: 0 0 12px;
  font-family: var(--stage-serif);
  font-size: 13.5px;
  line-height: 1.8;
}

.wiki-lead span {
  border-radius: 3px;
  transition: background-color 0.4s ease, box-shadow 0.4s ease;
}

.wiki-lead span.is-read {
  background: var(--stage-blue-soft);
  box-shadow: 0 0 0 3px var(--stage-blue-soft);
}

.wiki-h2 {
  margin: 14px 0 5px;
  padding-bottom: 3px;
  border-bottom: 1px solid var(--stage-wiki-soft);
  font-family: var(--stage-serif);
  font-size: 18px;
  font-weight: 400;
}

.wiki-p {
  margin: 0;
  font-family: var(--stage-serif);
  font-size: 12.5px;
  line-height: 1.7;
}

.wiki-infobox {
  border: 1px solid var(--stage-wiki-line);
  border-spacing: 0;
  background: var(--stage-wiki-panel);
  font-size: 12px;
  line-height: 1.5;
}

.wiki-infobox th,
.wiki-infobox td {
  padding: 2px 6px;
  text-align: left;
  vertical-align: top;
}

.wiki-infobox th {
  font-weight: 400;
  white-space: nowrap;
  color: var(--stage-wiki-muted);
}

/* ---- The side panel ---- */

.stage-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  background: var(--stage-white);
  color: var(--stage-ink);
}

.stage-panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 46px;
  padding: 0 10px 0 6px;
  border-bottom: 1px solid var(--stage-line);
}

.stage-session {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 32px;
  padding: 0 8px;
  border: 1px solid var(--stage-line-strong);
  border-radius: 9px;
  font-size: 12px;
}

.stage-session-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stage-session .ic-xs,
.stage-chevron {
  color: var(--stage-faint);
}

.stage-history,
.stage-tools,
.stage-status-end {
  display: flex;
  align-items: center;
  gap: 1px;
  color: var(--stage-muted);
}

.stage-new {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 11px;
  border-radius: 9px;
  background: var(--stage-soft);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}

.stage-tabs {
  display: flex;
  gap: 16px;
  padding: 10px 12px 0;
  font-size: 12px;
  color: var(--stage-faint);
}

.stage-tabs .is-active {
  font-weight: 500;
  color: var(--stage-ink);
}

.stage-chat {
  display: flex;
  flex: 1 0 auto;
  flex-direction: column;
  gap: 7px;
  /* `overflow: hidden` would otherwise let the row shrink below its content. */
  min-height: max-content;
  padding: 10px 12px;
  overflow: hidden;
  font-size: 12px;
  line-height: 1.5;
}

.stage-bubble {
  align-self: flex-end;
  max-width: 94%;
  padding: 8px 11px;
  border-radius: 11px;
  background: var(--stage-blue);
  color: var(--stage-white);
}

.stage-tool {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 22px;
  margin-top: 3px;
}

.stage-tool-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stage-tool-state {
  position: relative;
  flex: none;
  width: 12px;
  height: 12px;
}

.stage-spinner,
.stage-check {
  position: absolute;
  inset: 0;
  width: 12px;
  height: 12px;
  opacity: 0;
}

.stage-spinner {
  border: 1.5px solid var(--stage-line-strong);
  border-top-color: var(--stage-blue);
  border-radius: 50%;
}

.stage-spinner.is-on {
  opacity: 1;
  animation: stage-spin 0.8s linear infinite;
}

.stage-check {
  stroke-width: 2.2;
  color: var(--stage-ok);
}

.stage-check.is-on {
  opacity: 1;
}

.stage-reply-lead {
  margin: 2px 0 0;
}

.stage-reply-list {
  display: grid;
  gap: 1px;
  margin: 3px 0 0;
  padding-left: 17px;
}

.stage-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 0 10px;
  padding: 12px;
  border: 1px solid var(--stage-line);
  border-radius: 12px;
  font-size: 12.5px;
  font-weight: 500;
}

.stage-composer {
  margin: 8px 10px 10px;
  padding: 10px 10px 8px 12px;
  border: 1.5px solid var(--stage-ink);
  border-radius: 14px;
  background: var(--stage-white);
}

.stage-input {
  min-height: 20px;
  font-size: 12px;
  line-height: 1.5;
}

.stage-input.is-placeholder {
  color: var(--stage-faint);
}

.stage-caret {
  height: 14px;
  margin-left: 1px;
  vertical-align: -2px;
  background: var(--stage-ink);
}

.stage-clip {
  margin: 3px 0 7px;
  color: var(--stage-muted);
}

/* Chips wrap rather than truncate, so every label stays whole; the send
   button keeps the corner of the row whatever wraps. */
.stage-chips {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  padding-top: 8px;
  padding-right: 36px;
  border-top: 1px solid var(--stage-line);
  font-size: 12px;
}

.stage-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  color: var(--stage-chip-ink);
}

.stage-chip .ic-xs {
  color: var(--stage-muted);
}

.stage-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--stage-blue);
}

.stage-send {
  position: absolute;
  right: 0;
  bottom: 0;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--stage-soft);
  color: var(--stage-muted);
  transition: background-color 0.2s ease, color 0.2s ease;
}

.stage-send.is-on {
  background: var(--stage-ink);
  color: var(--stage-white);
}

/* ---- Pointer, trail, and click ripple ---- */

.stage-trail,
.stage-cursor,
.stage-ripple {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
}

.stage-trail {
  z-index: 2;
  width: 100%;
  height: 100%;
}

.stage-cursor {
  z-index: 3;
  width: 20px;
  height: 22px;
  opacity: 0;
  transition: opacity 0.25s ease;
  filter: var(--stage-cursor-shadow);
  will-change: transform;
}

.stage-cursor.is-on {
  opacity: 1;
}

.stage-cursor svg {
  display: block;
  width: 100%;
  height: 100%;
  fill: var(--stage-white);
  stroke: var(--stage-ink);
  stroke-width: 1.6;
  stroke-linejoin: round;
}

.stage-ripple {
  z-index: 2;
  width: 36px;
  height: 36px;
  margin: -18px 0 0 -18px;
  border: 2px solid var(--stage-blue);
  border-radius: 50%;
  opacity: 0;
}

.stage-ripple.is-on {
  animation: stage-ripple 0.6s ease-out both;
}

/* ---- Reveal steps: hidden until their turn, all shown in the static frame ---- */

.step {
  opacity: 0;
  transform: translateY(5px);
  transition: opacity 0.28s ease-out, transform 0.28s ease-out;
}

.step.is-on,
.is-static .step {
  opacity: 1;
  transform: none;
}

.step-fade {
  transform: none;
}

.is-static .stage-spinner {
  display: none;
}

.is-fading .stage-chat .step.is-on,
.is-fading .stage-status.is-on,
.is-fading .stage-page .wiki-article.is-on {
  opacity: 0;
  transition: opacity 0.5s ease-in;
}

.stage-caption {
  max-width: 40rem;
  margin: 0;
  padding: 0 20px;
  font-size: 12px;
  line-height: 1.6;
  letter-spacing: 0.01em;
  text-align: center;
  text-wrap: balance;
  color: var(--landing-muted);
}

/* ---- Narrow viewports ---- */

@media (max-width: 959px) {
  .stage-body {
    grid-template-columns: minmax(0, 1.45fr) minmax(286px, 1fr);
    min-height: 520px;
  }

  .stage-tools .ic:nth-child(-n + 2) {
    display: none;
  }

  /* The page column leaves the lead too little room beside the infobox. */
  .wiki-infobox {
    display: none;
  }

  .stage-chip:nth-child(n + 4) {
    display: none;
  }

  .stage-chrome {
    grid-template-columns: auto minmax(110px, 200px) minmax(0, 1fr) auto;
  }
}

@media (max-width: 719px) {
  .stage-body {
    grid-template-columns: minmax(0, 1fr);
    min-height: 0;
  }

  .stage-page {
    height: 196px;
    border-right: 0;
    border-bottom: 1px solid var(--stage-line);
  }

  /* No room for the status card beside a four-call reply: the reply carries the same title. */
  .stage-panel {
    min-height: 420px;
  }

  .stage-chrome {
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 10px;
  }

  .stage-omnibox,
  .stage-history,
  .stage-tools,
  .stage-clip,
  .stage-status,
  .stage-chip:nth-child(n + 3) {
    display: none;
  }

  .stage-composer {
    padding: 9px 10px 8px 12px;
  }

  .stage-tabs {
    padding: 8px 10px 0;
  }

  .stage-chat {
    padding: 8px 10px;
  }

  .wiki-home {
    gap: 8px;
    padding: 14px;
  }

  .wiki-home-title {
    font-size: 34px;
  }

  .wiki-search {
    height: 40px;
  }

  .wiki-article {
    padding: 12px 14px;
  }

  .wiki-title {
    font-size: 22px;
  }

  .wiki-content {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (prefers-reduced-motion: reduce) {
  .stage *,
  .stage *::before,
  .stage *::after {
    animation: none !important;
    transition: none !important;
  }

  .wiki-caret,
  .stage-caret {
    display: none;
  }
}

@keyframes stage-blink {
  50% {
    opacity: 0;
  }
}

@keyframes stage-spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes stage-load {
  0% {
    opacity: 1;
    transform: scaleX(0);
  }

  85% {
    opacity: 1;
    transform: scaleX(1);
  }

  100% {
    opacity: 0;
    transform: scaleX(1);
  }
}

@keyframes stage-ripple {
  0% {
    opacity: 0.75;
    transform: scale(0.25);
  }

  100% {
    opacity: 0;
    transform: scale(1);
  }
}
</style>
