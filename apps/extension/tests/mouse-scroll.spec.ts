/**
 * scroll() closed-loop guarantees (regression lock for the 真机批39/40 root
 * causes):
 * - Input.synthesizeScrollGesture resolving does not mean it took effect —
 *   a backgrounded window drops the gesture entirely (批39: scrollY stayed 0);
 * - resolving does not mean the animation finished — the settle wait runs
 *   INSIDE the page (one awaitPromise poll until two consecutive scrollY
 *   readings agree) and the residual is computed from that settled value
 *   (批40: first read caught mid-animation 225.5 of 661);
 * - the residual top-up covers dropped / partial / inverted gestures, and a
 *   script fallback covers pages where gesture synthesis is unavailable;
 * - a settle-poll TIMEOUT means unknown movement, not zero: ONE plain
 *   scrollY re-read computes the residual from the actual position, so a
 *   partial gesture is never double-scrolled; only when that re-read also
 *   fails does the operation degrade to zero movement;
 * - the pre-probe (viewport + start scrollY) and the settle are each ONE
 *   evaluate — a fully-delivered gesture costs exactly two evaluate calls.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const cdpSend = vi.fn<(tabId: number, method: string, params?: Record<string, unknown>) => Promise<unknown>>()
const evaluate = vi.fn<(tabId: number, expression: string) => Promise<unknown>>()

vi.mock('../src/background/cdp.ts', () => ({
  cdpController: {
    send: (tabId: number, method: string, params?: Record<string, unknown>) => cdpSend(tabId, method, params),
  },
  sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
}))

vi.mock('../src/background/dom-snapshot.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/background/dom-snapshot.ts')>()),
  evaluateInPage: (tabId: number, expression: string) => evaluate(tabId, expression),
  getElementRect: vi.fn(),
}))

vi.mock('../src/background/virtual-cursor.ts', () => ({
  showClick: vi.fn(async () => undefined),
  showGesture: vi.fn(async () => undefined),
  showScroll: vi.fn(async () => undefined),
}))

const { scroll } = await import('../src/background/mouse.ts')

/**
 * Queue the evaluate answers in call order: the first call is the combined
 * viewport+scrollY probe, the second the in-page settle poll. An absent
 * settle answer resolves undefined (the page returned nothing usable).
 * The settle poll is anchored by `setInterval` — the only evaluate whose
 * serialized source registers one.
 */
function probeScrollY(before: number, settled: number | undefined): void {
  evaluate.mockImplementation((_tabId: number, expression: string) => {
    if (expression.startsWith('(() => ({ width')) {
      return Promise.resolve({ width: 1334, height: 833, scrollY: before })
    }
    if (expression.includes('setInterval')) {
      return Promise.resolve(settled)
    }
    return Promise.resolve(undefined)
  })
}

function scrollByCalls(): number[] {
  return evaluate
    .mock.calls
    .map(call => call[1])
    .filter(expression => expression.startsWith('window.scrollBy'))
    .map(expression => Number(expression.match(/window\.scrollBy\(0, (-?\d+)\)/)?.[1]))
}

function evaluateCalls(): number {
  return evaluate.mock.calls.length
}

beforeEach(() => {
  cdpSend.mockReset()
  evaluate.mockReset()
  cdpSend.mockResolvedValue(undefined)
})

describe('mouse scroll closed loop', () => {
  it('tops up the full amount when the gesture is dropped (批39)', async () => {
    probeScrollY(0, 0) // before 0, settled 0 — nothing moved

    await scroll(7, 'down', 800)

    expect(cdpSend).toHaveBeenCalledWith(
      7,
      'Input.synthesizeScrollGesture',
      expect.objectContaining({ xDistance: 0, yDistance: 800 }),
    )
    expect(scrollByCalls()).toEqual([800])
  })

  it('computes the residual from the settled value, not the mid-animation read (批40)', async () => {
    // The in-page settle poll returns only once two consecutive readings
    // agree — the mock hands back the stable 225.5 directly.
    probeScrollY(0, 225.5)

    await scroll(7, 'down', 800)

    expect(scrollByCalls()).toEqual([575])
  })

  it('does not top up when the gesture fully delivered the amount', async () => {
    probeScrollY(0, 800)

    await scroll(7, 'down', 800)

    expect(scrollByCalls()).toEqual([])
  })

  it('spends at most two evaluate calls on a fully-delivered gesture (merged probe + settle)', async () => {
    probeScrollY(0, 800)

    await scroll(7, 'down', 800)

    // One combined viewport+scrollY probe + one in-page settle poll — the
    // old shape cost 1 (viewport) + 1 (before) + N (settle re-polls).
    expect(evaluateCalls()).toBeLessThanOrEqual(2)
  })

  it('skips the top-up when the residual is within tolerance', async () => {
    probeScrollY(0, 799.5)

    await scroll(7, 'down', 800)

    expect(scrollByCalls()).toEqual([])
  })

  it('tops up an inverted upward residual with the correct sign', async () => {
    // Up 400 from 261: gesture only delivered to 0, but 261 of the request
    // was already satisfied by the start position → residual −139.
    probeScrollY(261, 0)

    await scroll(7, 'up', 400)

    expect(cdpSend).toHaveBeenCalledWith(
      7,
      'Input.synthesizeScrollGesture',
      expect.objectContaining({ yDistance: -400 }),
    )
    expect(scrollByCalls()).toEqual([-139])
  })

  it('falls back to Runtime.evaluate scrollBy when gesture synthesis is unavailable', async () => {
    probeScrollY(0, 0)
    cdpSend.mockImplementation(((_tabId: number, method: string) =>
      method === 'Input.synthesizeScrollGesture'
        ? Promise.reject(new Error('not supported'))
        : Promise.resolve({ result: { value: undefined } })))

    await scroll(7, 'down', 800)

    expect(cdpSend).toHaveBeenCalledWith(
      7,
      'Runtime.evaluate',
      expect.objectContaining({ expression: 'window.scrollBy(0, 800)' }),
    )
    // Script fallback is the answer — no settle poll afterwards.
    expect(scrollByCalls()).toEqual([])
    expect(evaluate.mock.calls.filter(call => (call[1]).includes('setInterval'))).toHaveLength(0)
  })

  it('treats a settle timeout as unknown movement: re-reads the live scrollY and tops up only the actual remainder (不再双滚)', async () => {
    // The settle budget expired mid-animation (null), but the gesture HAD
    // partially scrolled: the one-shot re-read sees the real 500, so the
    // top-up is 300 — the old semantics would have topped up the full 800
    // on top of the partial gesture (double scroll).
    evaluate.mockImplementation((_tabId: number, expression: string) => {
      if (expression.startsWith('(() => ({ width')) {
        return Promise.resolve({ width: 1334, height: 833, scrollY: 0 })
      }
      if (expression.includes('setInterval')) {
        return Promise.resolve(null) // settle poll timed out
      }
      if (expression.startsWith('(() => window.scrollY')) {
        return Promise.resolve(500) // the one-shot re-read
      }
      return Promise.resolve(undefined)
    })

    await scroll(7, 'down', 800)

    expect(scrollByCalls()).toEqual([300])
  })

  it('degrades to zero movement only after the settle-timeout re-read also fails', async () => {
    evaluate.mockImplementation((_tabId: number, expression: string) => {
      if (expression.startsWith('(() => ({ width')) {
        return Promise.resolve(null) // probe answers nothing → safe viewport/start defaults
      }
      if (expression.includes('setInterval')) {
        return Promise.resolve(null) // settle poll timed out
      }
      if (expression.startsWith('(() => window.scrollY')) {
        return Promise.reject(new Error('执行环境已销毁')) // the re-read fails too
      }
      return Promise.resolve(undefined) // the residual top-up still lands
    })

    await scroll(7, 'down', 800)

    // Nothing readable anywhere → zero movement → full top-up (safe default).
    expect(scrollByCalls()).toEqual([800])
  })
})
