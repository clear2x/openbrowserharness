// @vitest-environment jsdom
/**
 * chrome-page-batch-tool (`page_batch_actions`, batch 278, hardened in
 * batch 280): pins the plan-validation contract (whole-plan check before
 * any action runs), the lane's actionability rules — click/type targets are
 * waited for and scrolled into view, mutating steps settle a triggered
 * navigation through the document mark, `wait` polls through a navigation —
 * stop-on-first-failure, and the timing config resolution. The
 * real-provider path (humanized clicks, hit-test misses, true navigation)
 * is exercised by the automation probes.
 * @module @deepseek-ai/dsh-extension/tests/chrome-page-batch-tool
 */
import { describe, expect, it, vi } from 'vitest'
import type { BrowserProvider } from '@deepseek-ai/dsh-browser'
import {
  apply,
  DEFAULT_ACTION_WAIT_MS,
  DEFAULT_POLL_MS,
  DEFAULT_SETTLE_BUDGET_MS,
  DEFAULT_SETTLE_QUIET_MS,
  executeBatchPlan,
  formatBatchOutput,
  MAX_BATCH_ACTIONS,
  parseBatchAction,
  parseBatchActions,
  resolveBatchTiming,
  settleAfterMutation,
  waitUntilTargetReady,
} from '../src/offscreen/chrome-page-batch-tool.ts'
import {
  BATCH_NAV_MARKER,
  documentStateExpression,
  parseDocumentState,
  prepareTargetInPage,
  targetProbeExpression,
} from '../src/offscreen/page-batch-page.ts'

/** Small real timers: every wait below resolves in tens of milliseconds. */
const TIMING = { actionWaitMs: 80, settleBudgetMs: 600, settleQuietMs: 20, pollMs: 5 }
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** What kind of page read an expression is. */
type ReadKind = 'probe' | 'arm' | 'state' | 'url'

function readKind(expression: string): ReadKind | undefined {
  if (expression.startsWith('(function prepareTargetInPage')) return 'probe'
  if (expression.includes('var n = (w[k] || 0) + 1')) return 'arm'
  if (expression.includes("document.readyState + '|'")) return 'state'
  if (expression === 'location.href') return 'url'
  return undefined
}

/** The scripted page a test hands to the fake provider. */
interface ScriptedPage {
  /** Target-probe answers per selector; a missing key answers `found`. */
  probes?: Record<string, string[]>
  /** Document-state answers in order; the last one repeats. */
  states?: string[]
  /** Expressions whose read throws (a navigation tearing the context down). */
  throwing?: ReadKind[]
  /** How many reads of each kind throw before the kind starts answering. */
  throwingFirst?: Partial<Record<ReadKind, number>>
  url?: string
}

/** A provider fake answering the lane's page reads from a script and recording every call in order. */
function fakePage(script: ScriptedPage = {}, overrides: Partial<BrowserProvider> = {}): { provider: BrowserProvider; calls: string[] } {
  const calls: string[] = []
  const probeIndex = new Map<string, number>()
  const readCount = new Map<ReadKind, number>()
  let stateIndex = 0
  const evaluate = async (_tabId: number, expression: string): Promise<unknown> => {
    const kind = readKind(expression)
    if (kind === undefined) throw new Error(`unexpected page read: ${expression.slice(0, 60)}`)
    const readsSoFar = readCount.get(kind) ?? 0
    readCount.set(kind, readsSoFar + 1)
    if ((script.throwingFirst?.[kind] ?? 0) > readsSoFar || script.throwing?.includes(kind)) {
      calls.push(`${kind}!throw`)
      throw new Error('Execution context was destroyed')
    }
    if (kind === 'probe') {
      // `})("<selector>", "<sentinel>", <resolver>, <flag>)` after the serialized body.
      const selector = expression.match(/\}\)\(("(?:[^"\\]|\\.)*"), "(?:[^"\\]|\\.)*", /u)?.[1] ?? '""'
      const name = JSON.parse(selector) as string
      const scrolls = expression.endsWith('true)')
      calls.push(`probe:${name}:${scrolls ? 'scroll' : 'observe'}`)
      const answers = script.probes?.[name]
      const index = probeIndex.get(name) ?? 0
      probeIndex.set(name, index + 1)
      return answers !== undefined ? (answers[Math.min(index, answers.length - 1)] ?? 'found') : 'found'
    }
    if (kind === 'arm') {
      calls.push('arm')
      return '1'
    }
    if (kind === 'state') {
      calls.push('state')
      const states = script.states ?? ['complete|same']
      const answer = states[Math.min(stateIndex, states.length - 1)] ?? 'complete|same'
      stateIndex += 1
      return answer
    }
    calls.push('url')
    return script.url ?? 'http://x/after'
  }
  const provider = {
    evaluate: evaluate as BrowserProvider['evaluate'],
    clickSelector: async (_tabId: number, selector: string): Promise<void> => {
      calls.push(`click:${selector}`)
    },
    clickPoint: async (_tabId: number, point: { x: number; y: number }): Promise<void> => { calls.push(`click_at:${String(point.x)},${String(point.y)}`) },
    typeText: async (_tabId: number, selector: string, _text: string, opts?: { submit?: boolean }): Promise<void> => {
      calls.push(`type:${selector}:${String(opts?.submit === true)}`)
    },
    pressKey: async (_tabId: number, key: string): Promise<void> => { calls.push(`press:${key}`) },
    scroll: async (): Promise<void> => { calls.push('scroll') },
    waitFor: async (): Promise<void> => { calls.push('provider.wait') },
    navigate: async (_tabId: number, url: string): Promise<void> => { calls.push(`navigate:${url}`) },
    ...Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key, value])),
  } as unknown as BrowserProvider
  return { provider, calls }
}

/** Give an element a fixed rendered box (jsdom reports every box as zero). */
function renderBox(element: HTMLElement, width: number, height: number): void {
  const box = { width, height, x: 0, y: 0, top: 0, left: 0, right: width, bottom: height }
  element.getBoundingClientRect = (): DOMRect => ({ ...box, toJSON: () => ({}) })
}

/** Drop the page-read bookkeeping lines, keeping the action lines. */
const actions = (calls: string[]): string[] => calls.filter(call => !/^(probe[:!]|arm$|arm!|state$|state!|url$|url!)/u.test(call))

describe('batch plan validation', () => {
  it('rejects an empty plan and a plan over the step cap before running anything', () => {
    expect(() => parseBatchActions([])).toThrow('不能为空')
    expect(() => parseBatchActions(Array.from({ length: MAX_BATCH_ACTIONS + 1 }, () => ({ op: 'press', key: 'Enter' })))).toThrow('不能超过')
  })

  it('rejects malformed steps with the step number in the message', () => {
    expect(() => parseBatchAction('click', 0)).toThrow('actions[0]')
    expect(() => parseBatchAction({ op: 'hover', selector: '#a' }, 1)).toThrow('op 非法')
    expect(() => parseBatchAction({ op: 'click' }, 2)).toThrow('actions[2]')
    expect(() => parseBatchAction({ op: 'click', selector: '  ' }, 0)).toThrow('selector')
    expect(() => parseBatchAction({ op: 'type', selector: '#a' }, 0)).toThrow('text')
    expect(() => parseBatchAction({ op: 'type', selector: '#a', text: '' }, 0)).toThrow('text')
    expect(() => parseBatchAction({ op: 'press' }, 0)).toThrow('key')
    expect(() => parseBatchAction({ op: 'scroll', direction: 'left' }, 0)).toThrow('direction')
    expect(() => parseBatchAction({ op: 'scroll', direction: 'down', amount_px: 0 }, 0)).toThrow('amount_px')
    expect(() => parseBatchAction({ op: 'wait', selector: '#a', timeout_ms: 31_000 }, 0)).toThrow('不能超过')
    expect(() => parseBatchAction({ op: 'navigate' }, 0)).toThrow('url')
  })

  it('accepts viewport-coordinate clicks and rejects malformed coordinates', () => {
    expect(parseBatchAction({ op: 'click_at', x: 120, y: 48 }, 0)).toMatchObject({ op: 'click_at', x: 120, y: 48, detail: 'click_at (120, 48)' })
    expect(() => parseBatchAction({ op: 'click_at', y: 48 }, 0)).toThrow('x 必须是非负有限数值')
    expect(() => parseBatchAction({ op: 'click_at', x: -1, y: 48 }, 0)).toThrow('x 必须是非负有限数值')
    expect(() => parseBatchAction({ op: 'click_at', x: Number.POSITIVE_INFINITY, y: 48 }, 0)).toThrow('x 必须是非负有限数值')
    expect(() => parseBatchAction({ op: 'click_at', x: '120', y: 48 }, 0)).toThrow('x 必须是非负有限数值')
  })

  it('builds a validated plan with per-step detail lines', () => {
    const plan = parseBatchActions([
      { op: 'type', selector: '#user', text: '某某的账号名' },
      { op: 'type', selector: '#pass', text: '密码文本', submit: true },
      { op: 'click', selector: '#login' },
      { op: 'wait', selector: '#welcome' },
    ])
    expect(plan.map(step => step.op)).toEqual(['type', 'type', 'click', 'wait'])
    expect(plan[0]?.detail).toContain('#user')
    expect(plan[1]?.detail).toContain('回车提交')
    expect(plan[3]?.detail).toContain('5000ms')
  })
})

describe('timing config', () => {
  it('applies the documented defaults to a missing or partial config', () => {
    expect(resolveBatchTiming({})).toEqual({
      actionWaitMs: DEFAULT_ACTION_WAIT_MS,
      settleBudgetMs: DEFAULT_SETTLE_BUDGET_MS,
      settleQuietMs: DEFAULT_SETTLE_QUIET_MS,
      pollMs: DEFAULT_POLL_MS,
    })
    expect(resolveBatchTiming({ actionWaitMs: 0, settleQuietMs: 900 })).toMatchObject({ actionWaitMs: 0, settleQuietMs: 900 })
  })
})

describe('page probes (page-batch-page)', () => {
  it('reports invalid / missing / found and scrolls only when asked', () => {
    document.body.innerHTML = '<button id="btn">按钮</button><div id="ghost"></div>'
    renderBox(document.getElementById('btn') ?? document.body, 80, 24)
    renderBox(document.getElementById('ghost') ?? document.body, 0, 0)
    const scroll = vi.fn()
    ;(Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scroll

    const resolve = (root: Element | Document | ShadowRoot, selector: string): Element | null => root.querySelector(selector)
    expect(prepareTargetInPage('#btn', 'sentinel', resolve, true)).toBe('found')
    expect(scroll).toHaveBeenCalledTimes(1)
    expect(scroll).toHaveBeenCalledWith({ block: 'center', inline: 'center', behavior: 'instant' })
    scroll.mockClear()
    expect(prepareTargetInPage('#btn', 'sentinel', resolve, false)).toBe('found')
    expect(scroll).not.toHaveBeenCalled()
    expect(prepareTargetInPage('#nope', 'sentinel', resolve, false)).toBe('missing')
    expect(prepareTargetInPage('#ghost', 'sentinel', resolve, false)).toBe('missing')
    expect(prepareTargetInPage('#x', 'sentinel', (): string => 'sentinel', false)).toBe('invalid')
    document.body.innerHTML = ''
  })

  it('builds fixed expressions that carry the selector and the scroll flag', () => {
    const scrolling = targetProbeExpression('#a[b="c"] >>> d', true)
    expect(scrolling.startsWith('(function prepareTargetInPage')).toBe(true)
    expect(scrolling).toContain('"#a[b=\\"c\\"] >>> d"')
    expect(scrolling.endsWith(', true)')).toBe(true)
    expect(targetProbeExpression('#a', false).endsWith(', false)')).toBe(true)
    expect(targetProbeExpression('#a', true)).not.toMatch(/var [A-Za-z_$][\w$]* = function/)
  })

  it('parses document states and refuses malformed reads', () => {
    expect(parseDocumentState('complete|same')).toEqual({ readyState: 'complete', document: 'same' })
    expect(parseDocumentState('loading|new')).toEqual({ readyState: 'loading', document: 'new' })
    expect(parseDocumentState(undefined)).toBeUndefined()
    expect(parseDocumentState('complete')).toBeUndefined()
    expect(parseDocumentState('complete|weird')).toBeUndefined()
    expect(documentStateExpression(BATCH_NAV_MARKER)).toContain(JSON.stringify(BATCH_NAV_MARKER))
  })
})

describe('target readiness wait', () => {
  it('polls until the target appears, then releases (a navigation tearing the read does not fail it)', async () => {
    const { provider, calls } = fakePage({
      // Unreadable twice (a navigation tearing the context down), missing once, then present.
      probes: { '#late': ['missing', 'found'] },
      throwingFirst: { probe: 2 },
    })
    await expect(waitUntilTargetReady(provider, 7, '#late', 400, true, TIMING, sleep)).resolves.toBeUndefined()
    expect(calls).toEqual(['probe!throw', 'probe!throw', 'probe:#late:scroll', 'probe:#late:scroll'])
  })

  it('times out with the selector in the message when the target never appears', async () => {
    const { provider } = fakePage({ probes: { '#never': ['missing'] } })
    await expect(waitUntilTargetReady(provider, 7, '#never', 30, true, TIMING, sleep)).rejects.toThrow('等待元素超时（30ms）：#never')
  })

  it('reports an unreadable page (mid-navigation) distinctly from a missing target', async () => {
    const { provider } = fakePage({ throwing: ['probe'] })
    await expect(waitUntilTargetReady(provider, 7, '#a', 30, true, TIMING, sleep)).rejects.toThrow('页面不可读')
  })

  it('surfaces an invalid selector syntax immediately', async () => {
    const { provider, calls } = fakePage({ probes: { 'a[': ['invalid'] } })
    await expect(waitUntilTargetReady(provider, 7, 'a[', 400, true, TIMING, sleep)).rejects.toThrow('选择器语法无效：a[')
    expect(calls).toHaveLength(1)
  })
})

describe('post-mutation settle', () => {
  it('releases a same-document step once the quiet window passed', async () => {
    const { provider, calls } = fakePage({ states: ['complete|same'] })
    const startedAt = Date.now()
    await settleAfterMutation(provider, 7, TIMING, sleep, true)
    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeGreaterThanOrEqual(TIMING.settleQuietMs)
    expect(elapsed).toBeLessThan(TIMING.settleBudgetMs)
    expect(calls.every(call => call === 'state')).toBe(true)
    expect(calls.length).toBeGreaterThanOrEqual(2)
  })

  it('awaits a committed navigation until the new document is interactive', async () => {
    const { provider, calls } = fakePage({ states: ['loading|new', 'loading|new', 'interactive|new'] })
    await settleAfterMutation(provider, 7, TIMING, sleep, true)
    expect(calls).toEqual(['state', 'state', 'state'])
  })

  it('releases on an exhausted budget without throwing when the page never settles', async () => {
    const { provider } = fakePage({ states: ['loading|new'] })
    const startedAt = Date.now()
    await expect(settleAfterMutation(provider, 7, { ...TIMING, settleBudgetMs: 60 }, sleep, true)).resolves.toBeUndefined()
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(55)
  })

  it('falls back to the quiet window when the mark could not be armed or read', async () => {
    const { provider } = fakePage({ throwing: ['state'] })
    await expect(settleAfterMutation(provider, 7, TIMING, sleep, false)).resolves.toBeUndefined()
    // With the mark armed but every read failing, the settle waits out its budget instead.
    const { provider: blind, calls } = fakePage({ throwing: ['state'] })
    await settleAfterMutation(blind, 7, { ...TIMING, settleBudgetMs: 60 }, sleep, true)
    expect(calls.length).toBeGreaterThan(2)
  })
})

describe('batch execution', () => {
  it('waits for and scrolls to each click/type target, settling after every mutating step', async () => {
    const { provider, calls } = fakePage({ url: 'http://x/after' })
    const value = await executeBatchPlan(provider, 7, parseBatchActions([
      { op: 'type', selector: '#user', text: 'u' },
      { op: 'click', selector: '#go' },
      { op: 'wait', selector: '#done' },
    ]), TIMING, sleep)
    expect(value).toMatchObject({ tabId: 7, total: 3, executed: 3, ok: true, finalUrl: 'http://x/after' })
    expect(actions(calls)).toEqual(['type:#user:false', 'click:#go'])
    // Target order: probe (with scroll) strictly before the action.
    const firstProbe = calls.indexOf('probe:#user:scroll')
    expect(calls.indexOf('type:#user:false')).toBeGreaterThan(firstProbe)
    expect(calls.indexOf('probe:#go:scroll')).toBeLessThan(calls.indexOf('click:#go'))
    // The wait step observes without scrolling.
    expect(calls).toContain('probe:#done:observe')
    expect(calls).not.toContain('probe:#done:scroll')
  })

  it('arms the navigation mark before a mutating step and reads the state after it', async () => {
    const { provider, calls } = fakePage()
    await executeBatchPlan(provider, 7, parseBatchActions([{ op: 'click', selector: '#go' }]), TIMING, sleep)
    const arm = calls.indexOf('arm')
    const click = calls.indexOf('click:#go')
    const state = calls.indexOf('state')
    expect(arm).toBeGreaterThan(-1)
    expect(arm).toBeLessThan(click)
    expect(click).toBeLessThan(state)
  })

  it('does not act on the next step until a step-triggered navigation committed and loaded', async () => {
    const { provider, calls } = fakePage({ states: ['loading|new', 'loading|new', 'complete|new'] })
    await executeBatchPlan(provider, 7, parseBatchActions([
      { op: 'click', selector: '#next' },
      { op: 'click', selector: '#on-next-page' },
    ]), TIMING, sleep)
    const firstClick = calls.indexOf('click:#next')
    const nextProbe = calls.indexOf('probe:#on-next-page:scroll')
    const settleReads = calls.slice(firstClick, nextProbe).filter(call => call === 'state')
    // Three settle reads (loading, loading, complete) sit between the first
    // click and the second step's first probe: the lane waited for the
    // navigation instead of racing it.
    expect(settleReads.length).toBeGreaterThanOrEqual(3)
    expect(firstClick).toBeLessThan(nextProbe)
    expect(actions(calls)).toEqual(['click:#next', 'click:#on-next-page'])
  })

  it('stops at the first failing step and reports the executed progress', async () => {
    const { provider } = fakePage({ url: 'http://x/after' }, {
      clickSelector: async (_tabId: number, selector: string): Promise<void> => {
        if (selector === '#missing') throw new Error('点击未命中目标：#missing（目标点被其他元素遮挡）')
      },
    })
    const value = await executeBatchPlan(provider, 7, parseBatchActions([
      { op: 'click', selector: '#ok' },
      { op: 'click', selector: '#missing' },
      { op: 'wait', selector: '#never' },
    ]), TIMING, sleep)
    expect(value.ok).toBe(false)
    expect(value.stoppedAt).toBe(2)
    expect(value.executed).toBe(2)
    expect(value.total).toBe(3)
    expect(value.steps.at(-1)?.error).toContain('#missing')
    expect(value.finalUrl).toBe('http://x/after')
  })

  it('stops when a click target never appears, before any click is dispatched', async () => {
    const { provider, calls } = fakePage({ probes: { '#gone': ['missing'] } })
    const value = await executeBatchPlan(provider, 7, parseBatchActions([
      { op: 'click', selector: '#gone' },
      { op: 'click', selector: '#after' },
    ]), { ...TIMING, actionWaitMs: 25 }, sleep)
    expect(value.ok).toBe(false)
    expect(value.steps[0]?.error).toContain('等待元素超时')
    expect(calls).not.toContain('click:#gone')
    expect(calls).not.toContain('click:#after')
  })

  it('clicks viewport coordinates without a target probe and passes typing options through', async () => {
    const { provider, calls } = fakePage()
    await executeBatchPlan(provider, 7, parseBatchActions([
      { op: 'click_at', x: 300, y: 150 },
      { op: 'type', selector: '#q', text: '关键词', submit: true },
      { op: 'scroll', direction: 'down', amount_px: 800 },
      { op: 'navigate', url: 'https://example.invalid/' },
    ]), TIMING, sleep)
    expect(actions(calls)).toEqual([
      'click_at:300,150',
      'type:#q:true',
      'scroll',
      'navigate:https://example.invalid/',
    ])
    // Only the type step probes its target; the coordinate click addresses no selector.
    expect(calls.filter(call => call.startsWith('probe:'))).toEqual(['probe:#q:scroll'])
  })

  it('uses the wait step budget when it is larger than the action wait', async () => {
    const { provider, calls } = fakePage({ probes: { '#slow': ['missing', 'missing', 'missing', 'missing', 'found'] } })
    const value = await executeBatchPlan(provider, 7, parseBatchActions([{ op: 'wait', selector: '#slow', timeout_ms: 400 }]), {
      ...TIMING,
      actionWaitMs: 10,
    }, sleep)
    expect(value.ok).toBe(true)
    expect(calls.filter(call => call === 'probe:#slow:observe').length).toBe(5)
  })
})

describe('render', () => {
  it('marks a full plan as fully successful with the re-snapshot guidance', () => {
    const text = formatBatchOutput({
      tabId: 3,
      total: 2,
      executed: 2,
      ok: true,
      steps: [
        { step: 1, op: 'click', ok: true, detail: 'click 「#login」' },
        { step: 2, op: 'click_at', ok: true, detail: 'click_at (10, 20)' },
      ],
      finalUrl: 'http://x/done',
    })
    expect(text).toContain('2/2 步全部成功')
    expect(text).toContain('2. ✓ click_at (10, 20)')
    expect(text).toContain('page_snapshot')
    expect(text).toContain('http://x/done')
  })

  it('reports the stop point and the unexecuted tail on failure', () => {
    const text = formatBatchOutput({
      tabId: 3,
      total: 3,
      executed: 2,
      ok: false,
      stoppedAt: 2,
      steps: [
        { step: 1, op: 'click', ok: true, detail: 'click 「#ok」' },
        { step: 2, op: 'click', ok: false, detail: 'click 「#missing」', error: '等待元素超时' },
      ],
    })
    expect(text).toContain('第 2 步失败')
    expect(text).toContain('2. ✗ click 「#missing」 — 等待元素超时')
    expect(text).toContain('尚未执行第 3 步')
  })
})

describe('registration', () => {
  it('registers exactly the page_batch_actions tool', () => {
    const registered: Array<{ name: string }> = []
    const ctx = { tools: { register: (tool: { name: string }): void => { registered.push(tool) } } }
    apply(ctx as never, {})
    expect(registered.map(tool => tool.name)).toEqual(['page_batch_actions'])
  })
})
