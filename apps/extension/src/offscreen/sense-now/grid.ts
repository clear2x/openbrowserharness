/**
 * Companion-watch frame math (the Sense Now capture-pipeline's extension
 * port): a 32×18 luminance sampling grid, the mean-plus-spike diff between
 * consecutive grids, and the pace table that decides which frames survive.
 * Pure functions — the canvas decode that feeds them lives in the tool layer.
 *
 * @module sense-now/grid
 */

/** Sampling grid resolution (16:9-shaped; each cell is a mean luminance). */
export const GRID_COLS = 32
export const GRID_ROWS = 18

/** One sampled frame: per-cell mean luminance in `[0, 1]`, row-major. */
export type FrameGrid = Float64Array

/** Watch pacing levels (Sense Now parity): threshold tightens as pace calms. */
export type WatchPace = 'calm' | 'normal' | 'dense'

/**
 * Sample one decoded frame into the luminance grid.
 * @param data - the frame's RGBA pixel data (ImageDataProvider's `data`).
 * @param width - the frame width in pixels.
 * @param height - the frame height in pixels.
 * @returns the row-major luminance grid.
 */
export function sampleGrid(data: Uint8ClampedArray, width: number, height: number): FrameGrid {
  const grid = new Float64Array(GRID_COLS * GRID_ROWS)
  const cellW = width / GRID_COLS
  const cellH = height / GRID_ROWS
  for (let row = 0; row < GRID_ROWS; row += 1) {
    const yStart = Math.floor(row * cellH)
    const yEnd = Math.max(yStart + 1, Math.floor((row + 1) * cellH))
    for (let col = 0; col < GRID_COLS; col += 1) {
      const xStart = Math.floor(col * cellW)
      const xEnd = Math.max(xStart + 1, Math.floor((col + 1) * cellW))
      let sum = 0
      let count = 0
      for (let y = yStart; y < yEnd; y += 1) {
        for (let x = xStart; x < xEnd; x += 1) {
          const offset = (y * width + x) * 4
          const r = data[offset] ?? 0
          const g = data[offset + 1] ?? 0
          const b = data[offset + 2] ?? 0
          sum += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
          count += 1
        }
      }
      grid[row * GRID_COLS + col] = count === 0 ? 0 : sum / count
    }
  }
  return grid
}

/** One consecutive-frame diff: the mean cell delta plus the spike count. */
export interface GridDiff {
  /** Mean absolute per-cell delta in `[0, 1]`. */
  mean: number
  /** Cells whose delta crossed the spike line (hard cuts, window switches). */
  spikes: number
}

/** Cell delta that counts as a spike (an isolated high cut). */
const SPIKE_DELTA = 0.18

/**
 * Diff two grids of the same shape.
 * @param previous - the earlier frame's grid.
 * @param current - the newer frame's grid.
 * @returns the mean delta and spike count.
 */
export function gridDiff(previous: FrameGrid, current: FrameGrid): GridDiff {
  let sum = 0
  let spikes = 0
  for (let index = 0; index < current.length; index += 1) {
    const before = previous[index] ?? 0
    const after = current[index] ?? 0
    const delta = Math.abs(after - before)
    sum += delta
    if (delta >= SPIKE_DELTA) spikes += 1
  }
  return { mean: sum / current.length, spikes }
}

/** Mean-delta keep thresholds per pace. */
const PACE_THRESHOLDS: Record<WatchPace, number> = { calm: 0.2, normal: 0.1, dense: 0.05 }

/** Spike count that keeps a frame at any pace (hard cuts survive calm mode). */
const KEEP_SPIKES = 6

/**
 * Whether one frame survives the pace's keep bar. The session's first frame
 * always survives (the sheet anchors on where the watch started).
 * @param diff - the frame's diff against the previous kept/captured grid.
 * @param pace - the session pace.
 * @param frameIndex - zero-based index within this watch round.
 * @returns true when the frame joins the sheet.
 */
export function shouldKeepFrame(diff: GridDiff, pace: WatchPace, frameIndex: number): boolean {
  if (frameIndex === 0) return true
  return diff.mean >= PACE_THRESHOLDS[pace] || diff.spikes >= KEEP_SPIKES
}
