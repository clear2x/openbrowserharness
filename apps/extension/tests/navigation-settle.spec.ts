/**
 * 导航智能等待 (the auto-settle built-in capability), unified across
 * navigate / go_back / go_forward: ONE in-page awaitPromise poll replaces
 * the fixed initial-load sleep plus SW-side readyState re-polling, and an
 * evaluate failure (the execution context being torn down by the navigation
 * itself) no longer ends the wait — the loop retries until the deadline.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const cdpSend = vi.fn<(tabId: number, method: string, params?: Record<string, unknown>) => Promise<unknown>>()
const evaluate = vi.fn<(tabId: number, expression: string) => Promise<unknown>>()
const settleState = vi.hoisted(() => ({ enabled: true }))

vi.mock('../src/background/cdp.ts', () => ({
  cdpController: {
    send: (tabId: number, method: string, params?: Record<string, unknown>) => cdpSend(tabId, method, params),
  },
  sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms))),
}))

vi.mock('../src/background/dom-snapshot.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/background/dom-snapshot.ts')>()),
  evaluateInPage: (tabId: number, expression: string) => evaluate(tabId, expression),
}))

vi.mock('../src/background/capability-gate.ts', () => ({
  autoSettleEnabled: async (): Promise<boolean> => settleState.enabled,
  trackingCleanEnabled: async (): Promise<boolean> => true,
  humanizedInputEnabled: async (): Promise<boolean> => false,
  submitGuardEnabled: async (): Promise<boolean> => false,
  cursorOverlayEnabled: async (): Promise<boolean> => false,
  animFreezeEnabled: async (): Promise<boolean> => false,
  bannerCleanEnabled: async (): Promise<boolean> => false,
  lazyLoadEnabled: async (): Promise<boolean> => false,
  privacyMaskEnabled: async (): Promise<boolean> => false,
  snapLeanEnabled: async (): Promise<boolean> => false,
  blockMediaEnabled: async (): Promise<boolean> => false,
  beaconBlockEnabled: async (): Promise<boolean> => false,
  safeClickEnabled: async (): Promise<boolean> => false,
  capabilityEnabled: async (_key: string, fallback: boolean): Promise<boolean> => {
    void _key
    return fallback
  },
}))

vi.mock('../src/background/dock.ts', () => ({
  dockTabBesidePanel: async (): Promise<void> => undefined,
  dockWindowForNewTab: async (): Promise<number | undefined> => undefined,
}))

vi.mock('../src/background/virtual-cursor.ts', () => ({
  noteBrowserOperation: vi.fn(async () => undefined),
  showClick: vi.fn(async () => undefined),
  showGesture: vi.fn(async () => undefined),
  showScroll: vi.fn(async () => undefined),
  showTypePulse: vi.fn(async () => undefined),
}))

const { executeCdpOp, settleNavigation } = await import('../src/background/ops.ts')

/** Queue of evaluate outcomes; Error entries throw, the last value repeats. */
function evaluateQueue(outcomes: Array<unknown>): void {
  const queue = [...outcomes]
  const last = outcomes[outcomes.length - 1]
  evaluate.mockImplementation(() => {
    const next = queue.length > 1 ? queue.shift() : queue[0]
    if (next instanceof Error) return Promise.reject(next)
    return Promise.resolve(next ?? last)
  })
}

/** The readyState settle poll the ops wait on. */
function settleExpressions(): string[] {
  return evaluate
    .mock.calls
    .map(call => call[1])
    .filter(expression => expression.includes("document.readyState === 'complete'"))
}

beforeEach(() => {
  cdpSend.mockReset()
  evaluate.mockReset()
  settleState.enabled = true
  cdpSend.mockResolvedValue(undefined)
})

describe('navigate settle (unified 导航智能等待)', () => {
  it('retries evaluate failures instead of giving up — two throws then complete', async () => {
    evaluateQueue([new Error('执行环境已销毁'), new Error('执行环境已销毁'), 'complete'])

    const result = await executeCdpOp('navigate', 5, { url: 'https://example.com' })

    expect(result.ok).toBe(true)
    expect(cdpSend).toHaveBeenCalledWith(5, 'Page.navigate', { url: 'https://example.com' })
    expect(settleExpressions()).toHaveLength(3)
  })

  it('stops as soon as the page reports complete', async () => {
    evaluateQueue(['complete'])

    await executeCdpOp('navigate', 5, { url: 'https://example.com' })

    expect(settleExpressions()).toHaveLength(1)
  })

  it('skips the wait entirely when the capability is off', async () => {
    settleState.enabled = false

    const result = await executeCdpOp('navigate', 5, { url: 'https://example.com' })

    expect(result.ok).toBe(true)
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('no longer sleeps a fixed 700–1000ms before settling', async () => {
    evaluateQueue(['complete'])
    const t0 = Date.now()

    await executeCdpOp('navigate', 5, { url: 'https://example.com' })

    expect(Date.now() - t0).toBeLessThan(700)
  })
})

describe('go_back / go_forward settle', () => {
  function history(currentIndex: number): void {
    cdpSend.mockImplementation(((_tabId: number, method: string) => {
      if (method === 'Page.getNavigationHistory') {
        return Promise.resolve({ currentIndex, entries: [{ id: 11 }, { id: 22 }] })
      }
      return Promise.resolve(undefined)
    }))
  }

  it('go_back settles the new document like navigate does', async () => {
    history(1)
    evaluateQueue([new Error('换文档中'), 'complete'])

    const result = await executeCdpOp('go_back', 5, {})

    expect(result).toMatchObject({ ok: true, data: { navigated: true } })
    expect(cdpSend).toHaveBeenCalledWith(5, 'Page.navigateToHistoryEntry', { entryId: 11 })
    expect(settleExpressions()).toHaveLength(2)
  })

  it('go_forward settles the new document like navigate does', async () => {
    history(0)
    evaluateQueue(['complete'])

    const result = await executeCdpOp('go_forward', 5, {})

    expect(result).toMatchObject({ ok: true, data: { navigated: true } })
    expect(cdpSend).toHaveBeenCalledWith(5, 'Page.navigateToHistoryEntry', { entryId: 22 })
    expect(settleExpressions()).toHaveLength(1)
  })

  it('never settles at the history boundary (the page did not change)', async () => {
    cdpSend.mockImplementation(((_tabId: number, method: string) => {
      if (method === 'Page.getNavigationHistory') {
        return Promise.resolve({ currentIndex: 0, entries: [{ id: 11 }] })
      }
      return Promise.resolve(undefined)
    }))

    const result = await executeCdpOp('go_back', 5, {})

    expect(result).toMatchObject({ ok: true, data: { navigated: false } })
    expect(evaluate).not.toHaveBeenCalled()
  })
})

describe('settleNavigation (deadline semantics)', () => {
  it('gives up silently at the deadline when the evaluate keeps failing', { timeout: 10_000 }, async () => {
    evaluate.mockImplementation(() => Promise.reject(new Error('执行环境已销毁')))

    await expect(settleNavigation(5, 180)).resolves.toBeUndefined()

    expect(settleExpressions().length).toBeGreaterThanOrEqual(2)
  })

  it('returns after the in-page budget without a complete verdict', async () => {
    // pollUntilExpression resolves null when its own timeout elapses — the
    // settle loop treats any resolved outcome as "this wait did its best".
    evaluateQueue([null])

    await expect(settleNavigation(5, 1_000)).resolves.toBeUndefined()
    expect(settleExpressions()).toHaveLength(1)
  })
})
