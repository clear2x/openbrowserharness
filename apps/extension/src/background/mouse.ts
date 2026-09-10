/**
 * Humanized mouse: Bezier trajectory movement + realistically paced clicks +
 * inertial scroll gestures (ported from the OpenBrowserHarness reference).
 *
 * Anti-detection details:
 * - total move duration scales with distance, 150~600ms (a Fitts-law
 *   approximation);
 * - per-tab "last mouse position" keeps trajectories continuous across
 *   operations;
 * - without history the start point lands 80~200px away from the target
 *   (as if moved in from anywhere);
 * - element click points jitter within ±1.5px of the center (same-size
 *   elements never get the identical landing spot); raw coordinate clicks
 *   land exactly;
 * - press/release interval 60~140ms, with a 40~120ms arrival pause before
 *   pressing (visual confirmation).
 */

import { generateBezierPath } from './bezier'
import { cdpController, sleep } from './cdp'
import { evaluateInPage, getElementRect, getViewport } from './dom-snapshot'
import { createRng } from './rng'
import { showClick, showGesture, showScroll } from './virtual-cursor'

export interface Point {
  x: number
  y: number
}

/** Per-tab last mouse position (keeps trajectories continuous). */
const lastPositions = new Map<number, Point>()

interface MouseEventParams {
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased'
  x: number
  y: number
  button: 'none' | 'left'
  buttons?: number
  clickCount?: number
}

async function dispatchMouse(
  tabId: number,
  params: MouseEventParams,
): Promise<void> {
  await cdpController.send(tabId, 'Input.dispatchMouseEvent', {
    pointerType: 'mouse',
    ...params,
  })
}

/** Random start without history: 80~200px around the target, ≥ 0. */
function randomStartNear(to: Point): Point {
  const r = createRng()
  const angle = r.rand(0, Math.PI * 2)
  const dist = r.rand(80, 200)
  return {
    x: Math.max(0, Math.round(to.x + Math.cos(angle) * dist)),
    y: Math.max(0, Math.round(to.y + Math.sin(angle) * dist)),
  }
}

/**
 * Move the mouse to the target along a Bezier path.
 * Inter-event delay = total duration × the path point's Δt;
 * total = 150ms + min(450ms, distance × 0.45~0.9) → 150~600ms.
 */
async function moveTo(tabId: number, to: Point): Promise<void> {
  const r = createRng()
  const from = lastPositions.get(tabId) ?? randomStartNear(to)
  const dist = Math.hypot(to.x - from.x, to.y - from.y)
  const durationMs = 150 + Math.min(450, dist * r.rand(0.45, 0.9))

  const path = generateBezierPath(from, to, { rng: r })

  // Visible virtual cursor: animate the SAME path/duration in the page before
  // the input stream starts, so both timelines share t0 (best-effort).
  await showGesture(tabId, path, durationMs)

  let prev: { x: number; y: number; t: number } | undefined
  for (const p of path) {
    if (prev) {
      await sleep(durationMs * Math.max(0, p.t - prev.t))
    }
    await dispatchMouse(tabId, {
      type: 'mouseMoved',
      x: p.x,
      y: p.y,
      button: 'none',
      buttons: 0,
    })
    prev = p
  }
  lastPositions.set(tabId, { x: to.x, y: to.y })
}

/**
 * Humanized click.
 * @param target CSS selector (center resolved, landing point jittered within
 *              ±1.5px) or exact coordinates (clicked verbatim)
 * @returns the actual clicked point
 */
export async function click(tabId: number, target: string | Point): Promise<Point> {
  const r = createRng()
  let point: Point

  if (typeof target === 'string') {
    const probe = await getElementRect(tabId, target)
    if (!probe) {
      throw new Error(`未找到可见元素，无法点击：${target}`)
    }
    // Landing jitter around the center (anti "always dead center"), still
    // guaranteed inside the element.
    const jx = Math.min(1.5, probe.rect.width / 4)
    const jy = Math.min(1.5, probe.rect.height / 4)
    point = {
      x: Math.round((probe.center.x + r.rand(-jx, jx)) * 10) / 10,
      y: Math.round((probe.center.y + r.rand(-jy, jy)) * 10) / 10,
    }
  } else {
    point = { x: target.x, y: target.y }
  }

  await moveTo(tabId, point)
  await sleep(r.randInt(40, 120)) // arrival → visual confirmation pause
  await dispatchMouse(tabId, {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  })
  void showClick(tabId, point) // fire-and-forget ripple, keeps press timing pure
  await sleep(r.randInt(60, 140))
  await dispatchMouse(tabId, {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  })
  return point
}

/**
 * Poll scrollY until two consecutive reads agree (gesture animations keep
 * mutating the page after Input.synthesizeScrollGesture resolves — 真机批40：
 * resolve 后立即读取只拿到动画中间态 225.5，残差按中间态计算导致欠补).
 */
async function settleScrollY(tabId: number, timeoutMs = 2500): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let last = (await evaluateInPage<number>(tabId, 'window.scrollY')) ?? 0
  while (Date.now() < deadline) {
    await sleep(150)
    const current = (await evaluateInPage<number>(tabId, 'window.scrollY')) ?? 0
    if (current === last) return current
    last = current
  }
  return last
}

/**
 * Humanized scroll: prefer Input.synthesizeScrollGesture (real gesture speed
 * curve, random speed 400~900), then close the loop on the settled scrollY —
 * the gesture resolves even when it is dropped (backgrounded/sleeping tab),
 * partially applied, or inverted (真机批39：报成功而 scrollY 恒 0 / 回跳 0)，
 * so the residual to the requested amount is corrected via window.scrollBy.
 */
export async function scroll(
  tabId: number,
  direction: 'up' | 'down',
  amountPx = 400,
): Promise<void> {
  const r = createRng()
  const amount = Math.max(1, Math.round(amountPx))
  const signed = direction === 'down' ? amount : -amount

  const vp = await getViewport(tabId)
  const before = (await evaluateInPage<number>(tabId, 'window.scrollY')) ?? 0
  // Directional streaks + chevrons at the gesture origin (viewport center,
  // the same point synthesizeScrollGesture uses) — fire-and-forget.
  void showScroll(tabId, { x: Math.round(vp.width / 2), y: Math.round(vp.height / 2) }, signed)
  try {
    await cdpController.send(tabId, 'Input.synthesizeScrollGesture', {
      x: Math.round(vp.width / 2),
      y: Math.round(vp.height / 2),
      xDistance: 0,
      yDistance: signed,
      speed: r.randInt(400, 900),
    })
  } catch {
    // Gesture synthesis unavailable (old version / restricted page) → script scroll.
    await cdpController.send(tabId, 'Runtime.evaluate', {
      expression: `window.scrollBy(0, ${signed})`,
      returnByValue: true,
    })
    return
  }
  const after = await settleScrollY(tabId)
  const residual = signed - (after - before)
  if (Math.abs(residual) > 1) {
    // Gesture dropped / partial / inverted → top up to the requested amount.
    await evaluateInPage(tabId, `window.scrollBy(0, ${Math.round(residual)})`)
  }
}
