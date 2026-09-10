/**
 * Cubic-Bezier humanized mouse trajectory (pure math, ported from the
 * OpenBrowserHarness reference implementation).
 *
 * - Control points bow 10%~30% of the distance along the perpendicular, with
 *   the second control point counter-bowed for a natural S-curve.
 * - Time remapping uses easeInOut (smoothstep): uniform time sampling maps to
 *   a path parameter that advances fastest mid-flight ("fast middle, slow
 *   ends" — acceleration, cruise, deceleration).
 * - Mid points carry a ±1~2px hand tremor; start/end stay exact.
 * - 25% chance of a 3~8px overshoot followed by 3 quick correction points
 *   landing exactly on the target.
 */

import { createRng, type Rng } from './rng'

export interface BezierPoint {
  x: number
  y: number
}

/** Path sample: coordinates plus normalized gesture time t ∈ [0,1]. */
export interface PathPoint {
  x: number
  y: number
  t: number
}

export interface BezierPathOptions {
  /** Sample count including endpoints; clamped into [12, 30]; default random 12~30. */
  steps?: number
  /** Perpendicular control-point offset as a distance ratio; default random 0.10~0.30. */
  curvature?: number
  /** Overshoot pixels; explicit 0 disables; default 25% chance of 3~8px. */
  overshootPx?: number
  /** Inject hand tremor (default true). */
  jitter?: boolean
  /** Random source (default: fresh Math.random instance). */
  rng?: Rng
}

/** Cubic Bezier interpolation (exported for unit tests). */
function cubicBezier(
  p0: BezierPoint,
  p1: BezierPoint,
  p2: BezierPoint,
  p3: BezierPoint,
  t: number,
): BezierPoint {
  const it = 1 - t
  const a = it * it * it
  const b = 3 * it * it * t
  const c = 3 * it * t * t
  const d = t * t * t
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  }
}

/** easeInOut (smoothstep): zero derivative at both ends, max in the middle. */
function easeInOut(t: number): number {
  return t * t * (3 - 2 * t)
}

const round2 = (v: number): number => Math.round(v * 100) / 100

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v))

/**
 * Generate the humanized path from `from` to `to` (12~30 points, t strictly
 * increasing 0→1). Inter-event delays come from `duration × Δt`, reproducing
 * the fast-middle rhythm.
 */
export function generateBezierPath(
  from: BezierPoint,
  to: BezierPoint,
  opts: BezierPathOptions = {},
): PathPoint[] {
  const r = opts.rng ?? createRng()

  const dx = to.x - from.x
  const dy = to.y - from.y
  const dist = Math.hypot(dx, dy)

  const points: PathPoint[] = []

  // Too close to need an arc: two exact points.
  if (dist < 3) {
    points.push({ x: round2(from.x), y: round2(from.y), t: 0 })
    points.push({ x: round2(to.x), y: round2(to.y), t: 1 })
    return points
  }

  const jitter = opts.jitter !== false

  // Overshoot decision.
  let overshootPx: number
  if (typeof opts.overshootPx === 'number') {
    overshootPx = opts.overshootPx
  } else {
    overshootPx = r.chance(0.25) ? r.rand(3, 8) : 0
  }
  overshootPx = clamp(overshootPx, 0, dist * 0.5)

  const ux = dx / dist // unit vector along the line
  const uy = dy / dist
  const nx = -uy // perpendicular (normal) unit vector
  const ny = ux

  // Actual endpoint (possibly past the target, corrected afterwards).
  const end: BezierPoint =
    overshootPx > 0
      ? { x: to.x + ux * overshootPx, y: to.y + uy * overshootPx }
      : { x: to.x, y: to.y }

  const ex = end.x - from.x
  const ey = end.y - from.y
  const spread = Math.hypot(ex, ey)

  // Control points: 20%~35% / 65%~80% along the line, random normal bows.
  const curvature =
    typeof opts.curvature === 'number' ? opts.curvature : r.rand(0.1, 0.3)
  const bowSign = r.chance(0.5) ? 1 : -1
  const bow1 = spread * curvature * bowSign
  const bow2 = -bow1 * r.rand(0.25, 1) // counter-bowed second control → S arc
  const d1 = r.rand(0.2, 0.35)
  const d2 = r.rand(0.65, 0.8)
  const p1: BezierPoint = {
    x: from.x + ux * spread * d1 + nx * bow1,
    y: from.y + uy * spread * d1 + ny * bow1,
  }
  const p2: BezierPoint = {
    x: from.x + ux * spread * d2 + nx * bow2,
    y: from.y + uy * spread * d2 + ny * bow2,
  }

  // Sampling.
  const totalSteps = clamp(Math.round(opts.steps ?? r.randInt(12, 30)), 12, 30)
  const hasOvershoot = overshootPx > 0
  const CORRECTION_STEPS = 3
  const mainSteps = hasOvershoot
    ? Math.max(9, totalSteps - CORRECTION_STEPS)
    : totalSteps
  // Time share of the main travel (overshoot included); correction keeps the rest.
  const tSplit = hasOvershoot ? r.rand(0.82, 0.9) : 1

  let tPrev = 0
  for (let i = 0; i < mainSteps; i++) {
    const isFirst = i === 0
    const isLast = i === mainSteps - 1
    // Normalized time → easeInOut path parameter.
    const tt = mainSteps === 1 ? 1 : i / (mainSteps - 1)
    const u = easeInOut(tt)
    const pt = cubicBezier(from, p1, p2, end, u)

    // Slight randomization of the time point avoids a strictly arithmetic
    // event rhythm (a robotic signature).
    let t = tt * tSplit
    if (!isFirst && !isLast) {
      t = clamp(t + r.rand(-0.008, 0.008), tPrev + 0.001, tSplit - 0.001)
    }

    // Position tremor: ±1~2px on mid points only.
    let x = pt.x
    let y = pt.y
    if (jitter && !isFirst && !isLast) {
      x += (r.chance(0.5) ? 1 : -1) * r.rand(1, 2)
      y += (r.chance(0.5) ? 1 : -1) * r.rand(1, 2)
    }

    points.push({ x: round2(x), y: round2(y), t: round2(t) })
    tPrev = t
  }

  // Overshoot correction: 3 quick points landing exactly on the target.
  if (hasOvershoot) {
    for (let j = 1; j <= CORRECTION_STEPS; j++) {
      const f = j / CORRECTION_STEPS
      let x = end.x + (to.x - end.x) * f
      let y = end.y + (to.y - end.y) * f
      if (j < CORRECTION_STEPS) {
        x += (r.chance(0.5) ? 1 : -1) * r.rand(0.5, 1.5)
        y += (r.chance(0.5) ? 1 : -1) * r.rand(0.5, 1.5)
      }
      points.push({
        x: round2(x),
        y: round2(y),
        t: round2(tSplit + (1 - tSplit) * f),
      })
    }
  }

  return points
}
