/**
 * scroll() closed-loop guarantees (regression lock for the 真机批39/40 root
 * causes):
 * - Input.synthesizeScrollGesture resolving does not mean it took effect —
 *   a backgrounded window drops the gesture entirely (批39: scrollY stayed 0);
 * - resolving does not mean the animation finished — scrollY keeps mutating
 *   after resolve, so the residual must be computed from the SETTLED value,
 *   not the first read (批40: first read caught mid-animation 225.5 of 661);
 * - the residual top-up covers dropped / partial / inverted gestures, and a
 *   script fallback covers pages where gesture synthesis is unavailable.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const cdpSend = vi.fn()
const evaluate = vi.fn()

vi.mock('../src/background/cdp.ts', () => ({
  cdpController: { send: (...args: unknown[]) => cdpSend(...args) },
  sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
}))

vi.mock('../src/background/dom-snapshot.ts', () => ({
  evaluateInPage: (...args: unknown[]) => evaluate(...args),
  getElementRect: vi.fn(),
  getViewport: async (): Promise<{ width: number; height: number }> => ({
    width: 1334,
    height: 833,
  }),
}))

vi.mock('../src/background/virtual-cursor.ts', () => ({
  showClick: vi.fn(async () => undefined),
  showGesture: vi.fn(async () => undefined),
  showScroll: vi.fn(async () => undefined),
}))

const { scroll } = await import('../src/background/mouse.ts')

/** Queue of window.scrollY readings; the last value repeats once consumed. */
function scriptScrollY(values: number[]): void {
  const queue = [...values]
  const last = values[values.length - 1] ?? 0
  evaluate.mockImplementation((_tabId: number, expression: string) => {
    if (expression === 'window.scrollY') {
      return Promise.resolve(queue.length > 0 ? queue.shift() : last)
    }
    if (expression.startsWith('window.scrollBy')) {
      return Promise.resolve(undefined)
    }
    return Promise.resolve(undefined)
  })
}

function scrollByCalls(): number[] {
  return evaluate
    .mock.calls
    .map(call => String(call[1]))
    .filter(expression => expression.startsWith('window.scrollBy'))
    .map(expression => Number(expression.match(/window\.scrollBy\(0, (-?\d+)\)/)?.[1]))
}

beforeEach(() => {
  cdpSend.mockReset()
  evaluate.mockReset()
  cdpSend.mockResolvedValue(undefined)
})

describe('mouse scroll closed loop', () => {
  it('tops up the full amount when the gesture is dropped (批39)', async () => {
    scriptScrollY([0, 0, 0]) // before, settle, settle — nothing moved

    await scroll(7, 'down', 800)

    expect(cdpSend).toHaveBeenCalledWith(
      7,
      'Input.synthesizeScrollGesture',
      expect.objectContaining({ xDistance: 0, yDistance: 800 }),
    )
    expect(scrollByCalls()).toEqual([800])
  })

  it('waits for the gesture animation to settle before computing the residual (批40)', async () => {
    // First settle read catches the mid-animation state 225.5; only after the
    // readings stabilize at 225.5 does the loop decide the residual.
    scriptScrollY([0, 100, 225.5, 225.5])

    await scroll(7, 'down', 800)

    expect(scrollByCalls()).toEqual([575])
  })

  it('does not top up when the gesture fully delivered the amount', async () => {
    scriptScrollY([0, 800, 800])

    await scroll(7, 'down', 800)

    expect(scrollByCalls()).toEqual([])
  })

  it('skips the top-up when the residual is within tolerance', async () => {
    scriptScrollY([0, 799.5, 799.5])

    await scroll(7, 'down', 800)

    expect(scrollByCalls()).toEqual([])
  })

  it('tops up an inverted upward residual with the correct sign', async () => {
    // Up 400 from 261: gesture only delivered to 0, but 261 of the request
    // was already satisfied by the start position → residual −139.
    scriptScrollY([261, 100, 0, 0])

    await scroll(7, 'up', 400)

    expect(cdpSend).toHaveBeenCalledWith(
      7,
      'Input.synthesizeScrollGesture',
      expect.objectContaining({ yDistance: -400 }),
    )
    expect(scrollByCalls()).toEqual([-139])
  })

  it('falls back to Runtime.evaluate scrollBy when gesture synthesis is unavailable', async () => {
    evaluate.mockImplementation(() => Promise.resolve(0))
    cdpSend.mockImplementation((_tabId: number, method: string) =>
      method === 'Input.synthesizeScrollGesture'
        ? Promise.reject(new Error('not supported'))
        : Promise.resolve({ result: { value: undefined } }),
    )

    await scroll(7, 'down', 800)

    expect(cdpSend).toHaveBeenCalledWith(
      7,
      'Runtime.evaluate',
      expect.objectContaining({ expression: 'window.scrollBy(0, 800)' }),
    )
    // Script fallback is the answer — no settle polling afterwards.
    expect(scrollByCalls()).toEqual([])
  })

  it('gives up polling after the settle timeout and uses the last reading', { timeout: 8000 }, async () => {
    let tick = 0
    evaluate.mockImplementation((_tabId: number, expression: string) => {
      if (expression === 'window.scrollY') {
        tick += 1
        return Promise.resolve(tick * 10) // never stabilizes
      }
      return Promise.resolve(undefined)
    })

    await scroll(7, 'down', 800)

    // Residual computed from the final unsettled reading (clamped ≥ the
    // timeout window), still a single deterministic top-up.
    const calls = scrollByCalls()
    expect(calls).toHaveLength(1)
    expect(800 - (calls[0] ?? 0)).toBeGreaterThan(0)
  })
})
