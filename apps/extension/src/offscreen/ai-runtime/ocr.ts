/**
 * The PaddleOCR pipeline's pure pre/post processing, CPU-first (batch 274):
 * image normalization for the det/rec ONNX graphs, a simplified DBNet
 * post-process (threshold + quarter-resolution flood fill + box expansion —
 * burned subtitles are large horizontal blocks, so rectangle approximations
 * carry them), and CTC decoding against the ppocr_keys_v1 dictionary. No
 * runtime APIs beyond plain typed arrays, so the whole file is unit-testable
 * in Node.
 *
 * @module ai-runtime/ocr
 */

/** The ImageNet normalization PaddleOCR's det graph expects. */
const DET_MEAN = [0.485, 0.456, 0.406] as const
const DET_STD = [0.229, 0.224, 0.225] as const

/** The det input's long-side cap and the multiple its sides round down to. */
export const DET_MAX_SIDE = 960
export const DET_SIDE_MULTIPLE = 32

/** One detected text region in frame coordinates. */
export interface TextBox {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Normalize an RGBA frame into the det graph's CHW float input, scaling the
 * longest side to at most {@link DET_MAX_SIDE} and rounding both sides down
 * to {@link DET_SIDE_MULTIPLE} multiples (the graph's stride requirement).
 * @param pixels - the RGBA pixels.
 * @param width - the frame width.
 * @param height - the frame height.
 * @returns the normalized tensor plus the geometry det ran at.
 */
export function detInputFrom(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): { data: Float32Array; width: number; height: number } {
  const scale = Math.min(1, DET_MAX_SIDE / Math.max(width, height))
  const outWidth = Math.max(DET_SIDE_MULTIPLE, Math.floor((width * scale) / DET_SIDE_MULTIPLE) * DET_SIDE_MULTIPLE)
  const outHeight = Math.max(DET_SIDE_MULTIPLE, Math.floor((height * scale) / DET_SIDE_MULTIPLE) * DET_SIDE_MULTIPLE)
  const data = new Float32Array(3 * outWidth * outHeight)
  const scaleX = width / outWidth
  const scaleY = height / outHeight
  for (let y = 0; y < outHeight; y += 1) {
    const sourceY = Math.min(height - 1, Math.round(y * scaleY))
    for (let x = 0; x < outWidth; x += 1) {
      const sourceX = Math.min(width - 1, Math.round(x * scaleX))
      const sourceIndex = (sourceY * width + sourceX) * 4
      const targetIndex = y * outWidth + x
      // Clamp-bounded indices above cannot miss; `?? 0` only satisfies the
      // indexed-read typing.
      const r = (pixels[sourceIndex] ?? 0) / 255
      const g = (pixels[sourceIndex + 1] ?? 0) / 255
      const b = (pixels[sourceIndex + 2] ?? 0) / 255
      data[targetIndex] = (r - DET_MEAN[0]) / DET_STD[0]
      data[outWidth * outHeight + targetIndex] = (g - DET_MEAN[1]) / DET_STD[1]
      data[2 * outWidth * outHeight + targetIndex] = (b - DET_MEAN[2]) / DET_STD[2]
    }
  }
  return { data, width: outWidth, height: outHeight }
}

/** The DB binarization threshold on the probability map. */
export const DET_BIN_THRESHOLD = 0.3

/** The cluster mask lives at this fraction of the probability-map grid. */
const MASK_DOWNSAMPLE = 4

/**
 * Extract text boxes from the det probability map. The simplified DB
 * post-process: binarize, max-pool into a quarter-resolution mask,
 * flood-fill clusters, keep plausible subtitle rectangles, and expand each
 * rectangle around its center to recover the DB shrink offset.
 * @param probMap - the det output, single channel at `width × height`.
 * @param width - the probability map width.
 * @param height - the probability map height.
 * @param frameWidth - the frame width the boxes map back to.
 * @param frameHeight - the frame height the boxes map back to.
 * @returns boxes in frame coordinates, reading order (top, then left).
 */
export function textBoxesFrom(
  probMap: Float32Array,
  width: number,
  height: number,
  frameWidth: number,
  frameHeight: number,
): TextBox[] {
  const maskWidth = Math.max(1, Math.floor(width / MASK_DOWNSAMPLE))
  const maskHeight = Math.max(1, Math.floor(height / MASK_DOWNSAMPLE))
  const mask = new Uint8Array(maskWidth * maskHeight)
  for (let y = 0; y < maskHeight; y += 1) {
    for (let x = 0; x < maskWidth; x += 1) {
      // Max-pool the cell: a stroke surviving at full res must survive the
      // mask even when its center pixel misses the sample grid.
      let peak = 0
      for (let dy = 0; dy < MASK_DOWNSAMPLE; dy += 1) {
        const sourceY = Math.min(height - 1, y * MASK_DOWNSAMPLE + dy)
        for (let dx = 0; dx < MASK_DOWNSAMPLE; dx += 1) {
          const sourceX = Math.min(width - 1, x * MASK_DOWNSAMPLE + dx)
          const value = probMap[sourceY * width + sourceX] ?? 0
          if (value > peak) peak = value
        }
      }
      mask[y * maskWidth + x] = peak >= DET_BIN_THRESHOLD ? 1 : 0
    }
  }
  const visited = new Uint8Array(mask.length)
  const boxes: TextBox[] = []
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] === 0 || visited[start] === 1) continue
    const stack = [start]
    visited[start] = 1
    let minX = maskWidth
    let maxX = -1
    let minY = maskHeight
    let maxY = -1
    while (stack.length > 0) {
      const index = stack.pop() ?? -1
      if (index < 0) break
      const x = index % maskWidth
      const y = Math.floor(index / maskWidth)
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nextX = x + dx
        const nextY = y + dy
        if (nextX < 0 || nextX >= maskWidth || nextY < 0 || nextY >= maskHeight) continue
        const nextIndex = nextY * maskWidth + nextX
        if (mask[nextIndex] === 0 || visited[nextIndex] === 1) continue
        visited[nextIndex] = 1
        stack.push(nextIndex)
      }
    }
    if (maxX < 0) continue
    // Map the mask rectangle back to frame coordinates (the mask cell grid
    // over-covers by up to one cell per side already) and expand around the
    // center to recover the DB training-time shrink.
    const scaleX = frameWidth / width
    const scaleY = frameHeight / height
    const x0 = (minX * MASK_DOWNSAMPLE) * scaleX
    const x1 = ((maxX + 1) * MASK_DOWNSAMPLE) * scaleX
    const y0 = (minY * MASK_DOWNSAMPLE) * scaleY
    const y1 = ((maxY + 1) * MASK_DOWNSAMPLE) * scaleY
    const expand = 1.25
    const cx = (x0 + x1) / 2
    const cy = (y0 + y1) / 2
    const w = Math.min(frameWidth, (x1 - x0) * expand)
    const h = Math.min(frameHeight, (y1 - y0) * expand)
    const left = Math.max(0, Math.round(cx - w / 2))
    const top = Math.max(0, Math.round(cy - h / 2))
    if (w < 8 || h < 8) continue
    boxes.push({ x: left, y: top, width: Math.round(Math.min(w, frameWidth - left)), height: Math.round(Math.min(h, frameHeight - top)) })
  }
  boxes.sort((a, b) => (a.y + a.height / 2) - (b.y + b.height / 2) || a.x - b.x)
  return boxes
}

/** The rec input's fixed height (PP-OCRv4 mobile) and width clamp. */
export const REC_HEIGHT = 48
export const REC_MAX_WIDTH = 800

/**
 * Normalize one cropped text region into the rec graph's CHW float input at
 * {@link REC_HEIGHT} height, width scaled proportionally and clamped.
 * @param pixels - the frame's RGBA pixels.
 * @param frameWidth - the frame width.
 * @param frameHeight - the frame height.
 * @param box - the region to crop.
 * @returns the normalized tensor and its width.
 */
export function recInputFrom(
  pixels: Uint8ClampedArray,
  frameWidth: number,
  frameHeight: number,
  box: TextBox,
): { data: Float32Array; width: number } {
  const width = Math.max(8, Math.min(REC_MAX_WIDTH, Math.round((box.width / box.height) * REC_HEIGHT)))
  const data = new Float32Array(3 * REC_HEIGHT * width)
  for (let y = 0; y < REC_HEIGHT; y += 1) {
    const sourceY = Math.min(frameHeight - 1, box.y + Math.floor((y / REC_HEIGHT) * box.height))
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(frameWidth - 1, box.x + Math.floor((x / width) * box.width))
      const sourceIndex = (sourceY * frameWidth + sourceX) * 4
      const targetIndex = y * width + x
      // The rec graph consumes raw [0,1] scaling (no ImageNet stats).
      data[targetIndex] = (pixels[sourceIndex] ?? 0) / 255
      data[REC_HEIGHT * width + targetIndex] = (pixels[sourceIndex + 1] ?? 0) / 255
      data[2 * REC_HEIGHT * width + targetIndex] = (pixels[sourceIndex + 2] ?? 0) / 255
    }
  }
  return { data, width }
}

/**
 * CTC-decode one rec output. Index 0 is the CTC blank; indices 1..n map to
 * `dictionary[idx - 1]`; the final index (the graph's `use_space_char`
 * class) is the space. Repeats collapse per the CTC rule.
 * @param logits - the rec output `[time, classes]`, row-major.
 * @param timeSteps - the time dimension.
 * @param classes - the class dimension.
 * @param dictionary - the character dictionary (one char per line).
 * @returns the decoded text.
 */
export function ctcDecode(
  logits: Float32Array,
  timeSteps: number,
  classes: number,
  dictionary: string[],
): string {
  const spaceIndex = dictionary.length + 1
  let text = ''
  let previous = -1
  for (let t = 0; t < timeSteps; t += 1) {
    let best = 0
    let bestScore = -Infinity
    for (let c = 0; c < classes; c += 1) {
      const score = logits[t * classes + c] ?? 0
      if (score > bestScore) {
        bestScore = score
        best = c
      }
    }
    if (best === 0 || best === previous) {
      previous = best
      continue
    }
    previous = best
    if (best === spaceIndex) {
      text += ' '
      continue
    }
    const char = dictionary[best - 1]
    if (char !== undefined) text += char
  }
  return text
}

/** Assemble the OCR outcome the tool layer reports. */
export interface OcrOutcome {
  /** The recognized lines in reading order. */
  lines: string[]
  /** The box count det produced (line count can be lower after dedupe). */
  boxes: number
}
