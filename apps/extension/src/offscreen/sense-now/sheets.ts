/**
 * Companion-watch sheet layout: kept frames montage into one image the model
 * reads in a single block (Sense Now's sheet, sized for tool-result image
 * caps). Pure geometry — the canvas paint lives in the tool layer.
 *
 * @module sense-now/sheets
 */

/** Max frames one sheet carries (a 2×2 grid). */
export const SHEET_MAX_FRAMES = 4

/** One kept frame's sheet input. */
export interface SheetFrame {
  /** The frame's capture data URL (JPEG). */
  dataUrl: string
  /** Seconds since the watch session started (for the cell label). */
  atSec: number
  /** Whether the frame survived the keep bar (vs the forced first frame). */
  kept: boolean
}

/** One sheet's geometry: cell placement plus canvas size. */
export interface SheetLayout {
  cols: number
  rows: number
  cellW: number
  cellH: number
  canvasW: number
  canvasH: number
  /** Per-frame top-left positions, in frame order. */
  positions: Array<{ x: number; y: number }>
}

/**
 * Compute the sheet geometry for one frame set: 1→1 col, 2–4→2 cols, cell
 * width halved per column so the sheet stays near one frame's footprint.
 * @param frameCount - how many frames are being montaged (clamped to 4).
 * @param frameW - one frame's natural width.
 * @param frameH - one frame's natural height.
 * @returns the layout (positions clamped to the frame count).
 */
export function sheetLayout(frameCount: number, frameW: number, frameH: number): SheetLayout {
  const count = Math.max(1, Math.min(SHEET_MAX_FRAMES, frameCount))
  const cols = count === 1 ? 1 : 2
  const rows = Math.ceil(count / cols)
  const cellW = cols === 1 ? frameW : Math.floor(frameW / 2)
  const cellH = cols === 1 ? frameH : Math.floor(frameH / 2)
  const positions: Array<{ x: number; y: number }> = []
  for (let index = 0; index < count; index += 1) {
    positions.push({ x: (index % cols) * cellW, y: Math.floor(index / cols) * cellH })
  }
  return { cols, rows, cellW, cellH, canvasW: cols * cellW, canvasH: rows * cellH, positions }
}
