// @vitest-environment jsdom
/**
 * chrome-page-batch-tool (`page_batch_actions`, batch 278): pins the
 * plan-validation contract (whole-plan check before any action runs), the
 * stop-on-first-failure progress report, the mutating-step readiness
 * settle, and the registration shape. The real-provider path (humanized
 * clicks, hit-test misses) is exercised by the automation probe.
 * @module @deepseek-ai/dsh-extension/tests/chrome-page-batch-tool
 */
import { describe, expect, it } from 'vitest'
import type { BrowserProvider } from '@deepseek-ai/dsh-browser'
import {
  apply,
  executeBatchPlan,
  formatBatchOutput,
  MAX_BATCH_ACTIONS,
  parseBatchAction,
  parseBatchActions,
  settlePageReady,
} from '../src/offscreen/chrome-page-batch-tool.ts'

/**
 * Build a string-returning evaluate fake assignable to the provider's
 * generic evaluate signature (the fake seam is the one deliberate cast).
 */
const evaluateFake = (impl: (tabId: number, expression: string) => Promise<string>): BrowserProvider['evaluate'] =>
  impl as BrowserProvider['evaluate']

/** A provider fake with just the batch lane's surface; overrides per test. */
function fakeProvider(overrides: Partial<BrowserProvider> = {}): BrowserProvider {
  return {
    evaluate: evaluateFake(async () => 'complete'),
    clickSelector: async () => undefined,
    typeText: async () => undefined,
    pressKey: async () => undefined,
    scroll: async () => undefined,
    waitFor: async () => undefined,
    navigate: async () => undefined,
    ...overrides,
  } as BrowserProvider
}

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

describe('readiness settle', () => {
  it('returns immediately on an already-complete document', async () => {
    const provider = fakeProvider()
    const startedAt = Date.now()
    expect(await settlePageReady(provider, 1, 1_000, 20)).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(500)
  })

  it('retries evaluate failures while a navigation tears down the context', async () => {
    let attempts = 0
    const provider = fakeProvider({
      evaluate: evaluateFake(async () => {
        attempts += 1
        if (attempts < 3) throw new Error('Execution context was destroyed')
        return 'complete'
      }),
    })
    expect(await settlePageReady(provider, 1, 2_000, 10)).toBe(true)
    expect(attempts).toBe(3)
  })

  it('reports a timeout instead of throwing when the page never settles', async () => {
    const provider = fakeProvider({ evaluate: evaluateFake(async () => { throw new Error('gone') }) })
    expect(await settlePageReady(provider, 1, 60, 10)).toBe(false)
  })
})

describe('batch execution', () => {
  it('runs a whole plan in order and attaches the final URL', async () => {
    const calls: string[] = []
    const provider = fakeProvider({
      clickSelector: async () => { calls.push('click') },
      typeText: async () => { calls.push('type') },
      waitFor: async () => { calls.push('wait') },
      evaluate: evaluateFake(async (_tabId, expression) => {
        calls.push(`evaluate:${expression}`)
        return expression === 'document.readyState' ? 'complete' : 'http://x/after'
      }),
    })
    const value = await executeBatchPlan(provider, 7, parseBatchActions([
      { op: 'type', selector: '#user', text: 'u' },
      { op: 'click', selector: '#go' },
      { op: 'wait', selector: '#done' },
    ]))
    expect(value).toMatchObject({ tabId: 7, total: 3, executed: 3, ok: true, finalUrl: 'http://x/after' })
    expect(calls[0]).toBe('type')
    // Each mutating step settles readiness before the next one runs.
    expect(calls[1]).toBe('evaluate:document.readyState')
    expect(calls[2]).toBe('click')
    expect(calls[3]).toBe('evaluate:document.readyState')
    expect(calls[4]).toBe('wait')
    expect(calls.at(-1)).toBe('evaluate:location.href')
  })

  it('stops at the first failing step and reports the executed progress', async () => {
    const provider = fakeProvider({
      clickSelector: async (_tabId, selector) => {
        if (selector === '#missing') throw new Error('等待元素超时: #missing')
      },
      waitFor: async () => { throw new Error('第 3 步不应执行') },
      evaluate: evaluateFake(async (_tabId, expression) => (expression === 'document.readyState' ? 'complete' : 'http://x/after')),
    })
    const value = await executeBatchPlan(provider, 7, parseBatchActions([
      { op: 'click', selector: '#ok' },
      { op: 'click', selector: '#missing' },
      { op: 'wait', selector: '#never' },
    ]))
    expect(value.ok).toBe(false)
    expect(value.stoppedAt).toBe(2)
    expect(value.executed).toBe(2)
    expect(value.total).toBe(3)
    expect(value.steps.at(-1)?.error).toContain('#missing')
    expect(value.finalUrl).toBe('http://x/after')
  })

  it('passes submit through typing and keeps scroll amounts verbatim', async () => {
    const typed: Array<{ selector: string; text: string; submit: boolean }> = []
    const scrolled: Array<{ direction: string; amountPx: number | undefined }> = []
    const provider = fakeProvider({
      typeText: async (_tabId, selector, text, opts) => { typed.push({ selector, text, submit: opts?.submit === true }) },
      scroll: async (_tabId, direction, amountPx) => { scrolled.push({ direction, amountPx }) },
    })
    await executeBatchPlan(provider, 1, parseBatchActions([
      { op: 'type', selector: '#q', text: '关键词', submit: true },
      { op: 'scroll', direction: 'down', amount_px: 800 },
    ]))
    expect(typed).toEqual([{ selector: '#q', text: '关键词', submit: true }])
    expect(scrolled).toEqual([{ direction: 'down', amountPx: 800 }])
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
        { step: 2, op: 'wait', ok: true, detail: 'wait 「#welcome」（5000ms）' },
      ],
      finalUrl: 'http://x/done',
    })
    expect(text).toContain('2/2 步全部成功')
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
    expect(text).toContain('✗')
    expect(text).toContain('尚未执行第 3 步')
    expect(text).toContain('等待元素超时')
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
